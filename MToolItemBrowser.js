//=============================================================================
// MToolItemBrowser.js
// 外部物品浏览器：在游戏进程内启动一个本地 HTTP 服务，用浏览器访问
// 功能：浏览全部物品 / 搜索 / 查看背包 / 添加 / 修改数量 / 移除
// 启动：window.MToolItemBrowser.start()   默认端口 8321
// 停止：window.MToolItemBrowser.stop()
//
// 性能要点（避免卡顿）：
//   1. 物品元数据只序列化一次并缓存，之后复用
//   2. 背包只遍历「实际持有」的条目，不做全量 numItems()
//   3. 页面分页渲染（每页 100），不一次性生成上千 DOM 节点
//   4. 不做定时轮询，改为操作后局部更新 + 手动刷新
//=============================================================================
(function () {
    'use strict';

    var DEFAULT_PORT = 8321;
    var server = null;
    var actualPort = null;

    //-------------------------------------------------------------------------
    // 工具
    //-------------------------------------------------------------------------
    function cleanText(s) {
        return ((s == null) ? '' : String(s))
            .replace(/\x1b\[[0-9]+/g, '')
            .replace(/\x1b/g, '')
            .replace(/\\[CcIiFfSs]\[[0-9]+\]/g, '')
            .trim();
    }

    function isReady() {
        return !!(typeof $dataItems !== 'undefined' && $dataItems &&
                  typeof $gameParty !== 'undefined' && $gameParty);
    }

    //-------------------------------------------------------------------------
    // 数据缓存
    //-------------------------------------------------------------------------
    var TYPE_DB = {
        item: function () { return $dataItems; },
        weapon: function () { return $dataWeapons; },
        armor: function () { return $dataArmors; }
    };

    /** 物品元数据缓存：首次构建后复用（数据库本身运行期不变） */
    var _allCache = null;

    function serializeItem(type, id, obj) {
        if (!obj || !obj.name) return null;
        var picMap = buildPicMap();
        return {
            type: type,
            id: id,
            name: cleanText(obj.name),
            desc: cleanText(obj.description),
            icon: (typeof obj.iconIndex === 'number') ? obj.iconIndex : 0,
            price: (typeof obj.price === 'number') ? obj.price : 0,
            pic: picMap[type + ':' + id] || null
        };
    }

    function allItems() {
        if (_allCache) return _allCache;
        var out = [];
        ['item', 'weapon', 'armor'].forEach(function (type) {
            var db = TYPE_DB[type]();
            if (!db) return;
            for (var i = 1; i < db.length; i++) {
                var s = serializeItem(type, i, db[i]);
                if (s) out.push(s);
            }
        });
        _allCache = out;
        return out;
    }

    /**
     * 背包快照：直接遍历 $gameParty._items/_weapons/_armors（只含持有项），
     * 避免对全部 2803 个物品调用 numItems()
     */
    function inventory() {
        var out = [];
        var groups = [
            { type: 'item', map: $gameParty._items, db: $dataItems },
            { type: 'weapon', map: $gameParty._weapons, db: $dataWeapons },
            { type: 'armor', map: $gameParty._armors, db: $dataArmors }
        ];
        groups.forEach(function (g) {
            if (!g.map || !g.db) return;
            for (var key in g.map) {
                if (!Object.prototype.hasOwnProperty.call(g.map, key)) continue;
                var count = g.map[key];
                if (!(count > 0)) continue;
                var id = Number(key);
                var s = serializeItem(g.type, id, g.db[id]);
                if (s) { s.count = count; out.push(s); }
            }
        });
        return out;
    }

    /** 只取一个条目的当前持有数量（用于操作后局部更新） */
    function countOf(type, id) {
        var o = getObject(type, id);
        if (!o) return 0;
        try { return $gameParty.numItems(o); } catch (e) { return 0; }
    }

    //-------------------------------------------------------------------------
    // 图标集：借用游戏 ImageManager 解密 IconSet，转成 PNG 二进制提供给浏览器
    // （游戏内 IconSet.png_ 是 RPGMV 加密格式，外部无法直接读取）
    //-------------------------------------------------------------------------
    var _iconSetBuf = null;
    var _iconSetMeta = null;

    function ensureIconSet() {
        if (_iconSetBuf) return _iconSetBuf;
        try {
            var bmp = ImageManager.loadSystem('IconSet');
            if (!bmp || !bmp.isReady() || !bmp._image) return null;
            var canvas = document.createElement('canvas');
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(bmp._image, 0, 0);
            var b64 = canvas.toDataURL('image/png').split(',')[1];
            _iconSetBuf = Buffer.from(b64, 'base64');
            _iconSetMeta = { width: bmp.width, height: bmp.height, size: 32 };
            return _iconSetBuf;
        } catch (e) {
            return null;
        }
    }

    function iconSetMeta() {
        if (_iconSetMeta) return _iconSetMeta;
        ensureIconSet();
        return _iconSetMeta || { width: 512, height: 640, size: 32 };
    }

    //-------------------------------------------------------------------------
    // 装备立绘映射：解析 CharacterPictureManager 的 PictureList
    // 每件护甲/武器在战斗中会切换到对应立绘，这里建立「装备 id → 立绘文件名」
    //-------------------------------------------------------------------------
    var _picMap = null;

    function buildPicMap() {
        if (_picMap) return _picMap;
        _picMap = {};
        try {
            var params = PluginManager.parameters('CharacterPictureManager');
            if (!params || !params.PictureList) return _picMap;
            var raw = JSON.parse(params.PictureList);
            raw.forEach(function (str) {
                var actor;
                try { actor = (typeof str === 'string') ? JSON.parse(str) : str; } catch (e) { return; }
                var filesRaw;
                try { filesRaw = JSON.parse(actor.FileList || '[]'); } catch (e) { return; }
                filesRaw.forEach(function (fstr) {
                    var f;
                    try { f = (typeof fstr === 'string') ? JSON.parse(fstr) : fstr; } catch (e) { return; }
                    if (!f || !f.FileName) return;
                    var armor = Number(f.Armor) || 0;
                    var weapon = Number(f.Weapon) || 0;
                    if (armor > 0 && !_picMap['armor:' + armor]) _picMap['armor:' + armor] = f.FileName;
                    if (weapon > 0 && !_picMap['weapon:' + weapon]) _picMap['weapon:' + weapon] = f.FileName;
                });
            });
        } catch (e) { /* 忽略 */ }
        return _picMap;
    }

    // 1x1 透明 PNG：立绘尚未解密到内存时返回它，避免浏览器显示破图标志
    var TRANSPARENT_PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
    );

    // 立绘缓存： key = name@maxWidth
    var _picCache = {};

    //-------------------------------------------------------------------------
    // 立绘组装：照抄 CharacterPictureManager 的图层匹配逻辑
    // 14 个图层组按顺序叠加，每组按条件选一个文件
    //-------------------------------------------------------------------------
    function dressupLayers(armorId, headId, weaponId, durableId, sim) {
        sim = sim || {};
        var actor = (typeof $gameParty !== 'undefined' && $gameParty.leader) ? $gameParty.leader() : null;
        // sim.hp / sim.states 可覆盖真实值；未提供时用游戏内真实状态
        var hpRate = (sim.hp != null && String(sim.hp) !== '')
            ? Number(sim.hp)
            : (actor ? actor.hpRate() * 100 : 100);
        var states;
        if (sim.states === 'none') states = [];
        else if (sim.states != null && String(sim.states) !== '')
            states = String(sim.states).split(',').map(Number).filter(function (x) { return x > 0; });
        else
            states = (actor ? actor.states().map(function (s) { return s.id; }) : []);
        var simVars = sim.vars || {};
        var out = [];
        try {
            var params = PluginManager.parameters('CharacterPictureManager');
            var raw = JSON.parse(params.PictureList);
            raw.forEach(function (s) {
                var a = JSON.parse(s);
                // 跳过 UI / 状态类图层（不是角色立绘本身）
                if (/背景|通缉|UI/i.test(a.Name || '')) return;
                var files = JSON.parse(a.FileList).map(function (x) { return JSON.parse(x); });
                var matched = files.filter(function (f) {
                    if (!f.FileName) return false;
                    var n = function (v) { return v != null && String(v) !== '' && String(v) !== '0'; };
                    var t = function (v) { return String(v) === 'true'; };
                    if (n(f.HpUpperLimit) && !(Number(f.HpUpperLimit) >= hpRate)) return false;
                    if (n(f.HpLowerLimit) && !(Number(f.HpLowerLimit) <= hpRate)) return false;
                    if (f.Motion && String(f.Motion) !== '') return false;
                    if (t(f.Action) || t(f.Inputting)) return false;
                    if (n(f.State) && states.indexOf(Number(f.State)) < 0) return false;
                    if (n(f.Weapon) && Number(f.Weapon) !== weaponId) return false;
                    // 护甲条件：衣服 / 头饰 / 耐久 任一匹配即可
                    if (n(f.Armor)) {
                        var aid = Number(f.Armor);
                        if (aid !== armorId && aid !== headId && aid !== durableId) return false;
                    }
                    if (f.Scene && String(f.Scene) !== '' && String(f.Scene) !== 'Scene_Battle') return false;
                    if (f.Note && String(f.Note) !== '') return false;
                    if (t(f.Message) || t(f.Face) || t(f.Speaker)) return false;
                    if (n(f.Switch)) return false;
                    // 变量条件：sim.vars 可覆盖（182 体型 / 183 表情 / 480 内衣 / 561 破损）
                    if (n(f.Variable)) {
                        var vid = Number(f.Variable);
                        var cur = (simVars[vid] != null && String(simVars[vid]) !== '')
                            ? Number(simVars[vid])
                            : Number($gameVariables.value(vid));
                        var operand = Number(f.VariableOperand);
                        var vtype = Number(f.VariableType);
                        var vok = false;
                        switch (vtype) {
                            case 0: vok = cur === operand; break;
                            case 1: vok = cur >= operand; break;
                            case 2: vok = cur <= operand; break;
                            case 3: vok = cur > operand; break;
                            case 4: vok = cur < operand; break;
                            case 5: vok = cur !== operand; break;
                        }
                        if (!vok) return false;
                    }
                    if (f.Script && String(f.Script) !== '') return false;
                    return true;
                });
                matched.forEach(function (mf) {
                    out.push({
                        group: a.Name,
                        file: mf.FileName,
                        x: Number(a.X) || 0,
                        y: Number(a.Y) || 0,
                        scaleX: Number(a.ScaleX) || 100,
                        scaleY: Number(a.ScaleY) || 100,
                        opacity: Number(a.Opacity) || 255
                    });
                });
            });
        } catch (e) { /* 忽略 */ }
        return { layers: out, context: { hpRate: Math.round(hpRate), states: states } };
    }

    /** 按游戏装备槽（$dataSystem.equipTypes 的 etypeId）给护甲分桶 */
    function armorCategories() {
        var out = { body: [], head: [], durable: [], other: [] };
        for (var i = 1; i < $dataArmors.length; i++) {
            var a = $dataArmors[i];
            if (!a || !a.name) continue;
            if (a.etypeId === 3) out.head.push(i);        // 头部
            else if (a.etypeId === 4) out.body.push(i);   // 防具
            else if (a.etypeId === 5) out.durable.push(i);// 耐久
            else out.other.push(i);
        }
        return out;
    }

    function getPictureBuf(name, maxW) {
        var key = name + '@' + maxW;
        if (_picCache[key]) return _picCache[key];
        var bmp;
        try { bmp = ImageManager.loadPicture(name); } catch (e) { return null; }
        if (!bmp) return null;
        if (!bmp.isReady()) {
            // 触发异步加载，稍后重试即可
            return null;
        }
        if (!bmp._image) return null;
        try {
            var w = bmp.width, h = bmp.height;
            var scale = Math.min(1, maxW / w);
            var cw = Math.max(1, Math.round(w * scale));
            var ch = Math.max(1, Math.round(h * scale));
            var canvas = document.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            canvas.getContext('2d').drawImage(bmp._image, 0, 0, cw, ch);
            var b64 = canvas.toDataURL('image/png').split(',')[1];
            var buf = Buffer.from(b64, 'base64');
            _picCache[key] = buf;
            return buf;
        } catch (e) {
            return null;
        }
    }

    //-------------------------------------------------------------------------
    // 背包操作
    //-------------------------------------------------------------------------
    function getObject(type, id) {
        var db = TYPE_DB[type] ? TYPE_DB[type]() : null;
        if (!db) return null;
        var it = db[id];
        return (it && it.name) ? it : null;
    }

    function actionAdd(type, id, count) {
        var it = getObject(type, id);
        if (!it) return { ok: false, error: 'not found' };
        count = Math.max(1, Math.min(9999, Number(count) || 1));
        $gameParty.gainItem(it, count);
        return { ok: true, count: countOf(type, id) };
    }

    function actionSet(type, id, count) {
        var it = getObject(type, id);
        if (!it) return { ok: false, error: 'not found' };
        count = Math.max(0, Math.min(9999, Number(count) || 0));
        var cur = countOf(type, id);
        if (count > cur) $gameParty.gainItem(it, count - cur);
        else if (count < cur) $gameParty.loseItem(it, cur - count);
        return { ok: true, count: countOf(type, id) };
    }

    function actionRemove(type, id) {
        return actionSet(type, id, 0);
    }

    //-------------------------------------------------------------------------
    // 页面
    //-------------------------------------------------------------------------
    function pageHtml() {
        return '<!DOCTYPE html>\n' + [
'<html lang="zh-CN">',
'<head>',
'<meta charset="utf-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1">',
'<title>物品浏览器 · MTool</title>',
'<style>',
'*{box-sizing:border-box;margin:0;padding:0}',
'body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#1a1d24;color:#d8dbe2;font-size:14px}',
'.header{position:sticky;top:0;z-index:10;background:#1a1d24;box-shadow:0 2px 10px #0008}',
'.top{background:#22262f;padding:12px 16px;border-bottom:1px solid #333a48;display:flex;gap:12px;flex-wrap:wrap;align-items:center}',
'.brand{font-weight:700;color:#7fd7ff;letter-spacing:1px}',
'.search{flex:1;min-width:220px;padding:8px 12px;border-radius:8px;border:1px solid #3a4150;background:#151820;color:#d8dbe2;outline:none}',
'.search:focus{border-color:#7fd7ff}',
'.tabs{display:flex;gap:6px;padding:10px 16px;background:#1d212a;border-bottom:1px solid #2c3240;flex-wrap:wrap;align-items:center}',
'.tab{padding:6px 14px;border-radius:16px;background:#262b36;color:#9aa3b2;cursor:pointer;border:1px solid transparent;user-select:none}',
'.tab.on{background:#2a4a5e;color:#9fe3ff;border-color:#3d7c96}',
'.stat{padding:6px 16px;color:#6b7484;font-size:12px}',
'.list{padding:8px 16px 80px}',
'.row{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-bottom:1px solid #23283380}',
'.row:hover{background:#20242e}',
'.icon{flex:none;width:32px;height:32px;border-radius:6px;background-image:url("/api/iconset");background-repeat:no-repeat;image-rendering:pixelated;background-color:#151820}',
'.bi-item{box-shadow:inset 0 0 0 2px #5f8fb8}',
'.bi-weapon{box-shadow:inset 0 0 0 2px #b8835f}',
'.bi-armor{box-shadow:inset 0 0 0 2px #7f8fb8}',
'.thumb{flex:none;width:120px;height:68px;object-fit:cover;border-radius:6px;border:1px solid #3a4150;background:#151820}',
'.info{flex:1;min-width:0}',
'.name{font-weight:600;color:#e8ecf4}',
'.name .id{color:#5c6577;font-weight:400;font-size:12px;margin-left:6px}',
'.desc{color:#8b94a6;font-size:12px;margin-top:3px;white-space:pre-wrap;word-break:break-all}',
'.count{flex:none;min-width:52px;text-align:right;color:#ffe28a;font-weight:700}',
'.ops{flex:none;display:flex;gap:4px;align-items:center}',
'button{cursor:pointer;border:1px solid #3a4150;background:#2a2f3a;color:#d8dbe2;border-radius:6px;padding:4px 9px;font-size:13px}',
'button:hover{background:#353c4a}',
'button.plus{color:#8cff8c}',
'button.minus{color:#ff8c8c}',
'.pager{position:fixed;bottom:0;left:0;right:0;background:#22262f;border-top:1px solid #333a48;padding:10px 16px;display:flex;gap:8px;justify-content:center;align-items:center;flex-wrap:wrap}',
'select{padding:4px 8px;border-radius:6px;border:1px solid #3a4150;background:#151820;color:#d8dbe2;font-size:13px}',
'.sep{color:#6b7484;font-size:12px}',
'.toast{position:fixed;bottom:64px;left:50%;transform:translateX(-50%);background:#2a4a5e;color:#9fe3ff;padding:10px 20px;border-radius:8px;opacity:0;transition:.2s;pointer-events:none}',
'.toast.show{opacity:1}',
'.preview{position:fixed;z-index:100;pointer-events:auto;cursor:pointer;border:2px solid #7fd7ff;border-radius:8px;background-color:#151820;background-repeat:no-repeat;image-rendering:pixelated;display:none;box-shadow:0 8px 24px #0009}',
'.preview img{display:block;max-width:640px;max-height:80vh;width:auto;height:auto;border-radius:6px}',
'.modal{position:fixed;inset:0;z-index:200;display:none;align-items:center;justify-content:center}',
'.modal.show{display:flex}',
'.modal-mask{position:absolute;inset:0;background:rgba(0,0,0,0.72)}',
'.modal-body{position:relative;z-index:1;cursor:pointer;max-width:92vw;max-height:92vh}',
'.modal-body img{display:block;max-width:92vw;max-height:92vh;border-radius:8px;box-shadow:0 12px 48px #000b;background:#151820}',
'.empty{color:#5c6577;text-align:center;padding:40px}',
'</style>',
'</head>',
'<body>',
'<div class="header">',
'  <div class="top">',
'    <div class="brand">物品浏览器</div>',
'    <input id="q" class="search" placeholder="搜索名称 / 描述 / ID…" autocomplete="off">',
'    <button id="reload">刷新</button>',
'  </div>',
'  <div class="tabs" id="tabs"></div>',
'</div>',
'<div class="stat" id="stat"></div>',
'<div class="list" id="list"></div>',
'<div class="pager" id="pager"></div>',
'<div class="preview" id="preview"></div>',
'<div class="modal" id="modal"></div>',
'<div class="toast" id="toast"></div>',
'<script>',
'var ALL = [], INV = {}, TAB = "all", PAGE = 0, FILTERED = [];',
'var PAGE_SIZE = 100; try { PAGE_SIZE = parseInt(localStorage.getItem("mteb_page_size") || "100", 10) || 100; } catch(e) {}',
'var IM = {w:512, h:640, s:32, cols:16};',
'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
'function iconHtml(t,i){i=Number(i)||0;var s=IM.s,c=IM.cols,x=-(i%c)*s,y=-Math.floor(i/c)*s;return "<div class=\\"icon bi-"+t+"\\" style=\\"background-position:"+x+"px "+y+"px;background-size:"+IM.w+"px "+IM.h+"px\\"></div>";}',
'function toast(msg){var e=document.getElementById("toast");e.textContent=msg;e.classList.add("show");clearTimeout(window._tt);window._tt=setTimeout(function(){e.classList.remove("show")},1200);}',
'function post(path, body){return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();});}',
'function load(){return fetch("/api/data").then(function(r){return r.json();}).then(function(d){',
'  if(d.iconMeta){ IM.w=d.iconMeta.width; IM.h=d.iconMeta.height; IM.s=d.iconMeta.size||32; IM.cols=Math.floor(IM.w/IM.s); }',
'  ALL = d.items;',
'  INV = {};',
'  d.inventory.forEach(function(x){ INV[x.type+":"+x.id] = x.count; });',
'  computeFilter();',
'});}',
'function setTabs(){',
'  var defs=[["all","全部"],["item","道具"],["weapon","武器"],["armor","护甲"],["inv","背包"]];',
'  document.getElementById("tabs").innerHTML = defs.map(function(t){return "<div class=\\"tab"+(TAB===t[0]?" on":"")+"\\" data-tab=\\""+t[0]+"\\">"+t[1]+"</div>";}).join("");',
'  document.querySelectorAll(".tab").forEach(function(el){ el.onclick=function(){ TAB=el.dataset.tab; PAGE=0; computeFilter(); }; });',
'}',
'function computeFilter(){',
'  var q = document.getElementById("q").value.toLowerCase().trim();',
'  var src = ALL;',
'  if(TAB==="inv"){ src = ALL.filter(function(x){ return (INV[x.type+":"+x.id]||0) > 0; }); }',
'  else if(TAB!=="all"){ src = ALL.filter(function(x){ return x.type===TAB; }); }',
'  if(q){ src = src.filter(function(x){ return (x.name+" "+x.desc+" "+x.id+" "+x.type).toLowerCase().indexOf(q)>=0; }); }',
'  FILTERED = src;',
'  if(PAGE*PAGE_SIZE >= src.length) PAGE = 0;',
'  render();',
'}',
'function render(){',
'  setTabs();',
'  var total = FILTERED.length;',
'  var pages = Math.max(1, Math.ceil(total/PAGE_SIZE));',
'  var start = PAGE*PAGE_SIZE;',
'  var slice = FILTERED.slice(start, start+PAGE_SIZE);',
'  document.getElementById("stat").textContent = "共 "+total+" 条 · 第 "+(PAGE+1)+"/"+pages+" 页"+(TAB==="inv"?"（背包）":"");',
'  if(!slice.length){ document.getElementById("list").innerHTML = "<div class=\\"empty\\">没有匹配的物品</div>"; }',
'  else {',
'    document.getElementById("list").innerHTML = slice.map(function(x){',
'      var k = x.type+":"+x.id, c = INV[k]||0;',
'      return "<div class=\\"row\\" data-k=\\""+k+"\\">"+iconHtml(x.type,x.icon)+(x.pic?"<img class=\\"thumb\\" loading=\\"lazy\\" src=\\"/api/picture?name="+encodeURIComponent(x.pic)+"&w=200\\" title=\\"点击查看大图\\" onclick=\\"openModal(\u0027"+x.pic+"\u0027)\\" onerror=\\"retryPic(this)\\">":"")+',
'        "<div class=\\"info\\"><div class=\\"name\\">"+esc(x.name)+"<span class=\\"id\\">#"+x.id+"</span></div><div class=\\"desc\\">"+esc(x.desc)+"</div></div>"+',
'        "<div class=\\"count\\">"+c+"</div>"+',
'        "<div class=\\"ops\\"><button class=\\"minus\\" data-t=\\""+x.type+"\\" data-i=\\""+x.id+"\\" data-c=\\"-1\\">−</button>"+',
'        "<button class=\\"plus\\" data-t=\\""+x.type+"\\" data-i=\\""+x.id+"\\" data-c=\\"1\\">+1</button>"+',
'        "<button class=\\"plus\\" data-t=\\""+x.type+"\\" data-i=\\""+x.id+"\\" data-c=\\"10\\">+10</button>"+',
'        "<button data-t=\\""+x.type+"\\" data-i=\\""+x.id+"\\" data-c=\\"set\\">✎</button></div></div>";',
'    }).join("");',
'    document.querySelectorAll("#list button").forEach(function(b){',
'      b.onclick = function(){',
'        var t=b.dataset.t, i=Number(b.dataset.i), c=b.dataset.c;',
'        if(c==="set"){',
'          var v = prompt("设置数量（0 = 移除）", INV[t+":"+i]||0);',
'          if(v===null) return;',
'          v = Number(v)||0;',
'          post("/api/set",{type:t,id:i,count:v}).then(function(r){ if(r.ok){ updateRow(t,i,r.count); } });',
'          return;',
'        }',
'        post("/api/add",{type:t,id:i,count:Number(c)}).then(function(r){ if(r.ok){ updateRow(t,i,r.count); } else toast("失败："+r.error); });',
'      };',
'    });',
'  }',
'  renderPager(pages);',
'}',
'function updateRow(t,i,count){',
'  INV[t+":"+i] = count;',
'  var row = document.querySelector(".row[data-k=\\""+t+":"+i+"\\"]");',
'  if(row){ var el = row.querySelector(".count"); if(el) el.textContent = count; }',
'  toast("已更新 → "+count);',
'}',
'function retryPic(img){var n=Number(img.dataset.r||0);if(n>=4){img.style.display="none";return;}img.dataset.r=n+1;setTimeout(function(){img.src=img.src.split("&r=")[0]+"&r="+Date.now();},700);}',
'var _hideTimer=null;',
'function cancelHide(){clearTimeout(_hideTimer);}',
'function scheduleHide(){cancelHide();_hideTimer=setTimeout(hidePreview,1500);}',
'function openFull(url){window.open(url,"_blank");}',
'function openModal(pic){',
'  var url="/api/picture?name="+encodeURIComponent(pic)+"&w=1280";',
'  var m=document.getElementById("modal");',
'  m.innerHTML="<div class=\\"modal-mask\\" onclick=\\"closeModal()\\"></div><div class=\\"modal-body\\"><img src=\\""+url+"\\" title=\\"点击在新标签打开\\" onclick=\\"openFull(\u0027"+url+"\u0027)\\"></div>";',
'  m.classList.add("show");',
'}',
'function closeModal(){document.getElementById("modal").classList.remove("show");}',
'function showPreview(item,btn){',
'  var el=document.getElementById("preview");',
'  if(item.pic){',
'    var url="/api/picture?name="+encodeURIComponent(item.pic)+"&w=640";',
'    el.style.backgroundImage="none";',
'    el.style.width="auto";el.style.height="auto";',
'    el.innerHTML="<img src=\\""+url+"\\" title=\\"点击在新标签打开\\" onclick=\\"openFull(\u0027"+url+"\u0027)\\">";',
'  } else {',
'    el.innerHTML="";',
'    var scale=6,s=IM.s||32;',
'    var col=item.icon%IM.cols,row=Math.floor(item.icon/IM.cols);',
'    el.style.width=(s*scale)+"px";el.style.height=(s*scale)+"px";',
'    el.style.backgroundImage="url(/api/iconset)";',
'    el.style.backgroundSize=(IM.w*scale)+"px "+(IM.h*scale)+"px";',
'    el.style.backgroundPosition=(-col*s*scale)+"px "+(-row*s*scale)+"px";',
'  }',
'  el.classList.add("show");',
'  var r=btn.getBoundingClientRect();',
'  var w=el.offsetWidth||640,h=el.offsetHeight||360;',
'  var x=r.left,y=r.bottom+8;',
'  if(x+w>window.innerWidth-8)x=Math.max(8,window.innerWidth-w-8);',
'  if(y+h>window.innerHeight-8)y=Math.max(8,r.top-h-8);',
'  el.style.left=x+"px";el.style.top=y+"px";',
'  cancelHide();',
'}',
'function hidePreview(){var el=document.getElementById("preview");el.classList.remove("show");}',
'function bindView(){',
'  document.querySelectorAll(".view").forEach(function(btn){',
'    btn.onclick=function(e){',
'      e.stopPropagation();',
'      var k=btn.dataset.t+":"+btn.dataset.i;',
'      var item=null;',
'      for(var i=0;i<FILTERED.length;i++){ if((FILTERED[i].type+":"+FILTERED[i].id)===k){item=FILTERED[i];break;} }',
'      if(item)showPreview(item,btn);',
'    };',
'  });',
'}',
'function renderPager(pages){',
'  document.getElementById("pager").innerHTML =',
'    "<button id=\\"prev\\">‹ 上一页</button>"+',
'    "<span>第 "+(PAGE+1)+" / "+pages+" 页</span>"+',
'    "<button id=\\"next\\">下一页 ›</button>"+',
'    "<span class=\\"sep\\">每页</span>"+',
'    "<select id=\\"pageSize\\">"+[50,100,200,500].map(function(n){return "<option value=\\""+n+"\\""+(n===PAGE_SIZE?" selected":"")+">"+n+" 条</option>";}).join("")+"</select>";',
'  document.getElementById("prev").onclick = function(){ if(PAGE>0){ PAGE--; render(); } };',
'  document.getElementById("next").onclick = function(){ if(PAGE<pages-1){ PAGE++; render(); } };',
'  document.getElementById("pageSize").onchange = function(){',
'    PAGE_SIZE = parseInt(this.value,10) || 100;',
'    try { localStorage.setItem("mteb_page_size", String(PAGE_SIZE)); } catch(e) {}',
'    PAGE = 0;',
'    render();',
'  };',
'}',
'(function(){',
'  var timer = null;',
'  document.getElementById("q").addEventListener("input", function(){',
'    clearTimeout(timer);',
'    timer = setTimeout(function(){ PAGE = 0; computeFilter(); }, 200);',
'  });',
'  document.getElementById("reload").onclick = function(){ PAGE = 0; load().then(function(){ toast("已刷新"); }); };',
'  var pv = document.getElementById("preview");',
'  pv.onmouseenter = cancelHide;',
'  pv.onmouseleave = scheduleHide;',
'  document.addEventListener("click", function(e){ if(!e.target.closest("#preview")) hidePreview(); });',
'  document.addEventListener("keydown", function(e){ if(e.key==="Escape") closeModal(); });',
'  load();',
'})();',
'</script>',
'</body>',
'</html>'
        ].join('\n');
    }

    //-------------------------------------------------------------------------
    // 立绘组装页面
    //-------------------------------------------------------------------------
    function dressupPageHtml() {
        return '<!DOCTYPE html>\n' + [
'<html lang="zh-CN">',
'<head>',
'<meta charset="utf-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1">',
'<title>立绘组装预览</title>',
'<style>',
'*{box-sizing:border-box;margin:0;padding:0}',
'html,body{height:100%}',
'body{font-family:"Microsoft YaHei",sans-serif;background:#14171c;color:#d8dbe2;font-size:13px;display:flex;flex-direction:column}',
'.bar{flex:none;background:#22262f;padding:10px 16px;border-bottom:1px solid #333a48;display:flex;gap:14px;align-items:center;flex-wrap:wrap}',
'.brand{font-weight:700;color:#7fd7ff;font-size:15px}',
'.ctx{color:#8b94a6;font-size:12px}',
'.main{flex:1;display:flex;min-height:0}',
'.col{flex:0 1 235px;min-width:168px;display:flex;flex-direction:column;min-height:0;background:#1a1d24;border-right:1px solid #2c3240}',
'.col.hidden{display:none}',
'.bar-btn{padding:4px 12px;font-size:12px;border-radius:8px;border:1px solid #3a4150;background:#2a2f3a;color:#c8cdd8;cursor:pointer;margin-left:auto}',
'.bar-btn.on{border-color:#7fd7ff;color:#7fd7ff}',
'.col h3{flex:none;padding:8px 12px;font-size:13px;color:#7fd7ff;border-bottom:1px solid #2c3240;display:flex;justify-content:space-between;align-items:center}',
'.col h3 span{color:#5c6577;font-weight:400}',
'.search{flex:none;width:100%;padding:7px 12px;border:none;border-bottom:1px solid #2c3240;background:#151820;color:#d8dbe2;outline:none}',
'.grid{flex:1;overflow-y:auto;padding:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px;align-content:start;grid-auto-rows:max-content}',
'.item{cursor:pointer;border:2px solid transparent;border-radius:8px;background:#20242e;overflow:hidden;transition:.12s}',
'.item:hover{background:#262b36;border-color:#3a4150}',
'.item.on{border-color:#7fd7ff;background:#2a4a5e}',
'.item img{display:block;width:100%;height:76px;object-fit:cover;background:#0b0d11}',
'.item.empty{background:#151820;border:2px dashed #3a4150}',
'.item.empty.on{border-color:#7fd7ff}',
'.item.empty .empty-icon{display:flex;align-items:center;justify-content:center;height:76px;color:#5c6577;font-size:22px}',
'.item .nm{padding:4px 6px;font-size:11px;color:#c8cdd8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'@media (max-width: 1500px){ .col{flex:0 1 190px;min-width:150px} }',
'@media (max-width: 1250px){ .col{flex:0 1 170px;min-width:136px} }',
'@media (max-width: 1100px){',
'  html,body{height:auto}',
'  body{display:block}',
'  .main{display:block;min-height:0}',
'  .col{width:100%;max-height:none;border-right:none;border-bottom:1px solid #2c3240}',
'  .grid{max-height:320px;overflow-y:auto}',
'  .center{padding:12px;border-left:none}',
'  .stage{max-width:100%}',
'  .item img{height:88px}',
'}',
'.center{flex:1;display:flex;flex-direction:column;min-width:0;padding:12px;gap:8px;border-left:1px solid #2c3240;justify-content:center}',
'.stage{flex:none;position:relative;background:#0b0d11;border:1px solid #2c3240;border-radius:12px;overflow:hidden;aspect-ratio:16/9;max-height:100%;max-width:100%;margin:0 auto;width:100%}',
'.stage img{position:absolute}',
'.layers{flex:none;display:flex;gap:6px;flex-wrap:wrap;max-height:70px;overflow-y:auto}',
'.layer{padding:4px 10px;border-radius:8px;background:#262b36;font-size:11px;color:#9aa3b2}',
'.hint{padding:20px;color:#5c6577;text-align:center}',
'.sim{flex:none;background:#1a1d24;border-top:1px solid #2c3240;max-height:300px;overflow-y:auto}',
'.sim-head{padding:9px 14px;cursor:pointer;color:#7fd7ff;font-size:13px;display:flex;gap:8px;align-items:center;user-select:none}',
'.sim-body{padding:6px 14px 12px;display:none}',
'.sim-row{display:flex;align-items:center;gap:8px;margin:5px 0;font-size:12px}',
'.sim-row label{width:48px;color:#8b94a6;flex:none}',
'.sim-row input[type=range]{flex:1;max-width:320px}',
'.sim-row select{background:#151820;color:#d8dbe2;border:1px solid #3a4150;border-radius:6px;padding:4px 8px}',
'.sim-val{min-width:56px;color:#9aa3b2}',
'.sim-grid{display:flex;gap:18px;flex-wrap:wrap}',
'.sim-states{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}',
'.sim-states label{display:flex;align-items:center;gap:4px;background:#262b36;border-radius:8px;padding:4px 9px;font-size:11px;cursor:pointer;border:1px solid transparent;color:#9aa3b2}',
'.sim-states label.on{border-color:#7fd7ff;background:#2a4a5e;color:#d8dbe2}',
'.sim-states input{display:none}',
'.sim-actions{margin-top:6px}',
'.sim-actions button{padding:6px 14px;font-size:12px}',
'</style>',
'</head>',
'<body>',
'<div class="bar">',
'  <div class="brand">立绘组装</div>',
'  <div class="ctx" id="ctx">加载中…</div>',
'  <button id="btnDurable" class="bar-btn" onclick="toggleDurable()">耐久 (2)</button>',
'</div>',
'<div class="main">',
'  <div class="col">',
'    <h3>衣服 <span id="armorCount"></span></h3>',
'    <input class="search" id="armorSearch" placeholder="搜索衣服…">',
'    <div class="grid" id="armorGrid"></div>',
'  </div>',
'  <div class="col">',
'    <h3>头饰 <span id="headCount"></span></h3>',
'    <input class="search" id="headSearch" placeholder="搜索头饰…">',
'    <div class="grid" id="headGrid"></div>',
'  </div>',
'  <div class="col">',
'    <h3>武器 <span id="weaponCount"></span></h3>',
'    <input class="search" id="weaponSearch" placeholder="搜索武器…">',
'    <div class="grid" id="weaponGrid"></div>',
'  </div>',
'  <div class="col hidden" id="durableCol">',
'    <h3>耐久 <span id="durableCount"></span></h3>',
'    <input class="search" id="durableSearch" placeholder="搜索耐久装备…">',
'    <div class="grid" id="durableGrid"></div>',
'  </div>',
'  <div class="center">',
'    <div class="stage" id="stage"></div>',
'    <div class="layers" id="layers"></div>',
'  </div>',
'</div>',
'<div class="sim">',
'  <div class="sim-head" id="simHead"><span>▸ 状态模拟</span><span id="simHint" style="color:#5c6577;font-weight:400">（当前为游戏真实状态）</span></div>',
'  <div class="sim-body" id="simBody">',
'    <div class="sim-row"><label>HP</label><input type="range" id="simHp" min="0" max="100" value="100"><span class="sim-val" id="simHpV">100%</span></div>',
'    <div class="sim-row"><label>破损</label><input type="range" id="simDmg" min="0" max="100" value="100"><span class="sim-val" id="simDmgV">100</span></div>',
'    <div class="sim-grid">',
'      <div class="sim-row"><label>体型</label><select id="simBody182"></select></div>',
'      <div class="sim-row"><label>表情</label><select id="simFace183"></select></div>',
'      <div class="sim-row"><label>内衣</label><select id="simUnder480"></select></div>',
'    </div>',
'    <div class="sim-row"><label>覆盖状态</label><input type="checkbox" id="simOverlay" style="width:auto"><span style="color:#8b94a6;font-size:11px">勾选后，用下方勾选的状态替换真实状态（可不选=无状态）</span></div>',
'    <div class="sim-states" id="simStates"></div>',
'    <div class="sim-actions"><button id="simReset">恢复真实状态</button></div>',
'  </div>',
'</div>',
'<script>',
'var armors = [], heads = [], durables = [], weapons = [];',
'var selArmor = 0, selHead = 0, selDurable = 0, selWeapon = 0;',
'function listOf(which) { return which === "armor" ? armors : (which === "head" ? heads : (which === "durable" ? durables : weapons)); }',
'function selOf(which) { return which === "armor" ? selArmor : (which === "head" ? selHead : (which === "durable" ? selDurable : selWeapon)); }',
'function setSel(which, id) { if (which === "armor") selArmor = id; else if (which === "head") selHead = id; else if (which === "durable") selDurable = id; else selWeapon = id; }',
'function picRetry(img) {',
'  if (img.naturalWidth > 2) return;',
'  var n = Number(img.dataset.r || 0);',
'  if (n >= 10) return;',
'  img.dataset.r = n + 1;',
'  setTimeout(function () {',
'    var base = img.src.split("&r=")[0];',
'    img.src = base + "&r=" + Date.now();',
'  }, 320);',
'}',
'function itemHtml(x, type) {',
'  var on = (x.id === selOf(type));',
'  return "<div class=\\"item" + (on ? " on" : "") + "\\" data-id=\\"" + x.id + "\\" data-t=\\"" + type + "\\">" +',
'    "<img loading=\\"lazy\\" onload=\\"picRetry(this)\\" style=\\"display:block;width:100%;height:76px;object-fit:cover;background:#0b0d11\\" src=\\"/api/picture?name=" + encodeURIComponent(x.pic) + "&w=160\\">" +',
'    "<div class=\\"nm\\">" + x.name + "</div></div>";',
'}',
'function renderList(which) {',
'  var list = listOf(which).slice();',
'  var q = (document.getElementById(which + "Search").value || "").toLowerCase().trim();',
'  if (q) list = list.filter(function (x) { return x.name.toLowerCase().indexOf(q) >= 0; });',
'  var grid = document.getElementById(which + "Grid");',
'  var emptyOn = selOf(which) === 0;',
'  var html = "<div class=\\"item empty" + (emptyOn ? " on" : "") + "\\" data-id=\\"0\\" data-t=\\"" + which + "\\">" +',
'    "<div class=\\"empty-icon\\">✕</div><div class=\\"nm\\">不穿</div></div>";',
'  html += list.map(function (x) { return itemHtml(x, which); }).join("");',
'  grid.innerHTML = html;',
'  grid.querySelectorAll(".item").forEach(function (el) {',
'    el.onclick = function () {',
'      var id = Number(el.dataset.id);',
'      setSel(which, (id === 0 || selOf(which) === id) ? 0 : id);',
'      renderList(which);',
'      refresh();',
'    };',
'  });',
'}',
'function refresh() {',
'  var url = "/api/dressup?armor=" + selArmor + "&head=" + selHead + "&durable=" + selDurable + "&weapon=" + selWeapon + simQuery();',
'  fetch(url).then(function (r) { return r.json(); }).then(function (d) {',
'    var stage = document.getElementById("stage");',
'    stage.innerHTML = "";',
'    d.layers.forEach(function (l) {',
'      var img = document.createElement("img");',
'      img.onload = function () { picRetry(this); };',
'      img.src = "/api/picture?name=" + encodeURIComponent(l.file) + "&w=1280";',
'      img.style.left = (l.x / 1280 * 100) + "%";',
'      img.style.top = (l.y / 720 * 100) + "%";',
'      img.style.width = l.scaleX + "%";',
'      img.style.height = l.scaleY + "%";',
'      img.style.opacity = (l.opacity / 255);',
'      stage.appendChild(img);',
'    });',
'    document.getElementById("ctx").textContent = "HP " + d.context.hpRate + "% · 状态 [" + d.context.states.join(",") + "] · " + d.layers.length + " 层";',
'    document.getElementById("layers").innerHTML = d.layers.map(function (l) {',
'      return "<div class=\\"layer\\">" + l.group + ": " + l.file + "</div>";',
'    }).join("");',
'    fitStage();',
'  });',
'}',
'var simStatesAll = [];',
'var simOv = { hp: "", damage: "", body: "", face: "", under: "", states: [] };',
'var overlayStates = false;',
'function simQuery() {',
'  var p = "";',
'  if (simOv.hp !== "") p += "&hp=" + simOv.hp;',
'  if (simOv.damage !== "") p += "&damage=" + simOv.damage;',
'  if (simOv.body !== "") p += "&body=" + simOv.body;',
'  if (simOv.face !== "") p += "&face=" + simOv.face;',
'  if (simOv.under !== "") p += "&under=" + simOv.under;',
'  if (overlayStates) p += "&states=" + (simOv.states.length ? simOv.states.join(",") : "none");',
'  return p;',
'}',
'function updateSimHint() {',
'  var n = 0;',
'  if (simOv.hp !== "") n++;',
'  if (simOv.damage !== "") n++;',
'  if (simOv.body !== "") n++;',
'  if (simOv.face !== "") n++;',
'  if (simOv.under !== "") n++;',
'  if (overlayStates) n++;',
'  var el = document.getElementById("simHint");',
'  el.textContent = n ? ("（模拟中 · " + n + " 项覆盖）") : "（当前为游戏真实状态）";',
'  el.style.color = n ? "#7fd7ff" : "#5c6577";',
'}',
'function toggleSim() {',
'  var b = document.getElementById("simBody");',
'  var open = b.style.display !== "block";',
'  b.style.display = open ? "block" : "none";',
'  document.getElementById("simHead").querySelector("span").textContent = open ? "▾ 状态模拟" : "▸ 状态模拟";',
'}',
'function fillSimSelect(id, n) {',
'  var sel = document.getElementById(id);',
'  var html = "<option value=\\"\\">真实</option>";',
'  for (var i = 1; i <= n; i++) html += "<option value=\\"" + i + "\\">" + i + "</option>";',
'  sel.innerHTML = html;',
'  sel.onchange = function () {',
'    var key = id === "simBody182" ? "body" : (id === "simFace183" ? "face" : "under");',
'    simOv[key] = sel.value;',
'    updateSimHint();',
'    refresh();',
'  };',
'}',
'function renderSimStates() {',
'  var box = document.getElementById("simStates");',
'  if (!box) return;',
'  box.innerHTML = simStatesAll.map(function (st) {',
'    var on = simOv.states.indexOf(st.id) >= 0;',
'    return "<label class=\\"" + (on ? "on" : "") + "\\" data-sid=\\"" + st.id + "\\">" +',
'      "<input type=\\"checkbox\\" " + (on ? "checked" : "") + ">" + st.name + "(" + st.id + ")</label>";',
'  }).join("");',
'  box.querySelectorAll("label").forEach(function (lb) {',
'    lb.onclick = function (e) {',
'      e.preventDefault();',
'      var id = Number(lb.dataset.sid);',
'      var idx = simOv.states.indexOf(id);',
'      if (idx >= 0) simOv.states.splice(idx, 1); else simOv.states.push(id);',
'      lb.classList.toggle("on");',
'      updateSimHint();',
'      refresh();',
'    };',
'  });',
'}',
'function resetSim() {',
'  simOv = { hp: "", damage: "", body: "", face: "", under: "", states: [] };',
'  document.getElementById("simHp").value = 100;',
'  document.getElementById("simDmg").value = 100;',
'  document.getElementById("simHpV").textContent = "100%";',
'  document.getElementById("simDmgV").textContent = "100";',
'  ["simBody182", "simFace183", "simUnder480"].forEach(function (id) { document.getElementById(id).value = ""; });',
'  renderSimStates();',
'  updateSimHint();',
'  refresh();',
'}',
'function toggleDurable() {',
'  var el = document.getElementById("durableCol");',
'  var btn = document.getElementById("btnDurable");',
'  if (!el || !btn) return;',
'  var hidden = el.classList.toggle("hidden");',
'  btn.classList.toggle("on", !hidden);',
'  btn.textContent = hidden ? ("耐久 (" + durables.length + ")") : "隐藏耐久";',
'  setTimeout(fitStage, 30);',
'}',
'function fitStage() {',
'  var stage = document.getElementById("stage");',
'  if (!stage) return;',
'  var wrap = stage.parentElement;',
'  var availW = wrap.clientWidth - 24;',
'  var availH = wrap.clientHeight - 24;',
'  var layers = document.getElementById("layers");',
'  if (layers && layers.offsetHeight) availH -= (layers.offsetHeight + 8);',
'  var ratio = 16 / 9;',
'  var w = availW, h = w / ratio;',
'  if (h > availH) { h = availH; w = h * ratio; }',
'  if (w < 120 || h < 68) { w = availW; h = w / ratio; }',
'  stage.style.width = Math.round(w) + "px";',
'  stage.style.height = Math.round(h) + "px";',
'}',
'function load() {',
'  return Promise.all([',
'    fetch("/api/data").then(function (r) { return r.json(); }),',
'    fetch("/api/armorcats").then(function (r) { return r.json(); }),',
'    fetch("/api/states").then(function (r) { return r.json(); })',
'  ]).then(function (arr) {',
'    var d = arr[0], cats = arr[1], st = arr[2];',
'    function pick(ids) { return d.items.filter(function (x) { return x.type === "armor" && x.pic && ids.indexOf(x.id) >= 0; }); }',
'    armors = pick(cats.body || []);',
'    heads = pick(cats.head || []);',
'    durables = pick(cats.durable || []);',
'    weapons = d.items.filter(function (x) { return x.type === "weapon" && x.pic; });',
'    document.getElementById("armorCount").textContent = armors.length + " 件";',
'    document.getElementById("headCount").textContent = heads.length + " 件";',
'    document.getElementById("durableCount").textContent = durables.length + " 件";',
'    document.getElementById("btnDurable").textContent = "耐久 (" + durables.length + ")";',
'    document.getElementById("weaponCount").textContent = weapons.length + " 件";',
'    renderList("armor");',
'    renderList("head");',
'    renderList("durable");',
'    renderList("weapon");',
'    simStatesAll = st.states || [];',
'    fillSimSelect("simBody182", 4);',
'    fillSimSelect("simFace183", 14);',
'    fillSimSelect("simUnder480", 6);',
'    renderSimStates();',
'    document.getElementById("simHead").onclick = toggleSim;',
'    var hp = document.getElementById("simHp");',
'    hp.oninput = function () { simOv.hp = this.value; document.getElementById("simHpV").textContent = this.value + "%"; updateSimHint(); };',
'    hp.onchange = refresh;',
'    var dmg = document.getElementById("simDmg");',
'    dmg.oninput = function () { simOv.damage = this.value; document.getElementById("simDmgV").textContent = this.value; updateSimHint(); };',
'    dmg.onchange = refresh;',
'    document.getElementById("simReset").onclick = resetSim;',
'    document.getElementById("simOverlay").onchange = function () { overlayStates = this.checked; updateSimHint(); refresh(); };',
'    window.addEventListener("resize", fitStage);',
'    fitStage();',
'    updateSimHint();',
'    refresh();',
'  });',
'}',
'["armor","head","durable","weapon"].forEach(function (k) {',
'  document.getElementById(k + "Search").addEventListener("input", function () { renderList(k); });',
'});',
'load();',
'</script>',
'</body>',
'</html>'
        ].join('\n');
    }

    //-------------------------------------------------------------------------
    // HTTP 服务
    //-------------------------------------------------------------------------
    function readBody(req, cb) {
        var chunks = [];
        req.on('data', function (c) { chunks.push(c); });
        req.on('end', function () {
            try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch (e) { cb({}); }
        });
    }

    function sendJson(res, obj) {
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(obj));
    }

    function handle(req, res) {
        try {
            var url = req.url.split('?')[0];

            if (req.method === 'OPTIONS') {
                res.writeHead(200, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                });
                res.end();
                return;
            }

            if (!isReady()) {
                sendJson(res, { ok: false, error: 'game not ready', items: [], inventory: [] });
                return;
            }

            if (url === '/' || url === '/index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(pageHtml());
                return;
            }

            if (url === '/api/data') {
                sendJson(res, { ok: true, items: allItems(), inventory: inventory(), iconMeta: iconSetMeta() });
                return;
            }

            if (url === '/api/iconset') {
                var buf = ensureIconSet();
                if (!buf) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('IconSet not ready (game may still be loading)');
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'image/png',
                    'Content-Length': buf.length,
                    'Cache-Control': 'public, max-age=86400'
                });
                res.end(buf);
                return;
            }

            if (url === '/api/picture') {
                var qs = (req.url.split('?')[1] || '');
                var q = {};
                qs.split('&').forEach(function (kv) {
                    var p = kv.split('=');
                    if (p[0]) q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
                });
                var pname = q.name || '';
                var maxW = Number(q.w) || 200;
                if (!pname || pname.indexOf('..') >= 0 || /[\\\0]/.test(pname) ||
                    !/^[A-Za-z0-9_\/\.\- ]+$/.test(pname)) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('bad name');
                    return;
                }
                var pbuf = getPictureBuf(pname, maxW);
                if (!pbuf) {
                    // 图片仍在异步加载中：返回透明占位图（200），前端检测到 1x1 后会重试
                    res.writeHead(200, {
                        'Content-Type': 'image/png',
                        'Content-Length': TRANSPARENT_PNG.length,
                        'Cache-Control': 'no-store'
                    });
                    res.end(TRANSPARENT_PNG);
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'image/png',
                    'Content-Length': pbuf.length,
                    'Cache-Control': 'public, max-age=86400'
                });
                res.end(pbuf);
                return;
            }

            if (url === '/api/dressup') {
                var qs2 = (req.url.split('?')[1] || '');
                var q2 = {};
                qs2.split('&').forEach(function (kv) {
                    var p = kv.split('=');
                    if (p[0]) q2[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
                });
                var sim = {
                    hp: q2.hp,
                    states: q2.states,
                    vars: { 182: q2.body, 183: q2.face, 480: q2.under, 561: q2.damage }
                };
                var dr = dressupLayers(Number(q2.armor) || 0, Number(q2.head) || 0, Number(q2.weapon) || 0, Number(q2.durable) || 0, sim);
                sendJson(res, { ok: true, layers: dr.layers, context: dr.context });
                return;
            }

            if (url === '/api/states') {
                var sts = [];
                try {
                    var p2 = PluginManager.parameters('CharacterPictureManager');
                    var r2 = JSON.parse(p2.PictureList);
                    r2.forEach(function (s) {
                        var a2 = JSON.parse(s);
                        var fs2 = JSON.parse(a2.FileList).map(function (x) { return JSON.parse(x); });
                        fs2.forEach(function (f) {
                            if (!f.FileName) return;
                            var sid = Number(f.State) || 0;
                            if (sid > 0 && sts.indexOf(sid) < 0) sts.push(sid);
                        });
                    });
                } catch (e) { /* 忽略 */ }
                var list = sts.map(function (id) {
                    var st = $dataStates[id];
                    return { id: id, name: (st && st.name) || ('状态 #' + id) };
                }).sort(function (a, b) { return a.id - b.id; });
                sendJson(res, { ok: true, states: list });
                return;
            }

            if (url === '/api/armorcats') {
                sendJson(res, armorCategories());
                return;
            }

            if (url === '/dressup' || url === '/dressup.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(dressupPageHtml());
                return;
            }

            if (url === '/api/add' && req.method === 'POST') {
                readBody(req, function (b) {
                    sendJson(res, actionAdd(b.type, Number(b.id), Number(b.count)));
                });
                return;
            }

            if (url === '/api/set' && req.method === 'POST') {
                readBody(req, function (b) {
                    sendJson(res, actionSet(b.type, Number(b.id), Number(b.count)));
                });
                return;
            }

            if (url === '/api/remove' && req.method === 'POST') {
                readBody(req, function (b) {
                    sendJson(res, actionRemove(b.type, Number(b.id)));
                });
                return;
            }

            sendJson(res, { ok: false, error: 'unknown route: ' + url });
        } catch (err) {
            try { sendJson(res, { ok: false, error: String((err && err.message) || err) }); } catch (e) { /* ignore */ }
        }
    }

    //-------------------------------------------------------------------------
    // 启动 / 停止
    //-------------------------------------------------------------------------
    /** 取本机局域网 IPv4 地址（用于展示访问入口） */
    function getLanIp() {
        try {
            var os = require('os');
            var ifaces = os.networkInterfaces();
            var ip = null;
            Object.keys(ifaces).forEach(function (name) {
                (ifaces[name] || []).forEach(function (i) {
                    if (!ip && i.family === 'IPv4' && !i.internal) ip = i.address;
                });
            });
            return ip;
        } catch (e) {
            return null;
        }
    }

    function start(port) {
        if (server) return { ok: true, port: actualPort || port || DEFAULT_PORT, note: 'already running' };
        if (!isReady()) return { ok: false, error: '游戏未就绪（$dataItems 不存在）' };
        try {
            var http = require('http');
            var p = port || DEFAULT_PORT;
            server = http.createServer(handle);
            server.on('error', function (err) {
                console.error('[MToolItemBrowser] server error:', err && err.message);
                server = null;
            });
            // 监听 0.0.0.0：允许局域网访问（同一网络下的手机/平板也可打开）
            server.listen(p, '0.0.0.0', function () {
                actualPort = server.address().port;
                var lan = getLanIp();
                console.log('[MToolItemBrowser] listening on 0.0.0.0:' + actualPort +
                            (lan ? '  (LAN: http://' + lan + ':' + actualPort + ')' : ''));
            });
            var lanIp = getLanIp();
            return {
                ok: true,
                port: p,
                bind: '0.0.0.0',
                url: 'http://' + (lanIp || '127.0.0.1') + ':' + p,
                localUrl: 'http://127.0.0.1:' + p,
                lanIp: lanIp
            };
        } catch (err) {
            server = null;
            return { ok: false, error: String((err && err.message) || err) };
        }
    }

    function stop() {
        if (!server) return { ok: true, note: 'not running' };
        try { server.close(); } catch (e) { /* ignore */ }
        server = null;
        actualPort = null;
        return { ok: true };
    }

    function status() {
        var lan = getLanIp();
        return {
            running: !!server,
            port: actualPort,
            bind: '0.0.0.0',
            url: actualPort ? ('http://' + (lan || '127.0.0.1') + ':' + actualPort) : null,
            localUrl: actualPort ? ('http://127.0.0.1:' + actualPort) : null,
            lanIp: lan,
            ready: isReady(),
            cachedItems: (_allCache ? _allCache.length : 0)
        };
    }

    window.MToolItemBrowser = {
        start: start,
        stop: stop,
        status: status,
        allItems: allItems,
        inventory: inventory,
        add: actionAdd,
        set: actionSet,
        remove: actionRemove,
        invalidateCache: function () { _allCache = null; }
    };

    if (isReady()) {
        setTimeout(function () { if (!server) start(); }, 1000);
    }
})();
