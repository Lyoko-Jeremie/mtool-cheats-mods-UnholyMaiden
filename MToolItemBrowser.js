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
        return {
            type: type,
            id: id,
            name: cleanText(obj.name),
            desc: cleanText(obj.description),
            icon: (typeof obj.iconIndex === 'number') ? obj.iconIndex : 0,
            price: (typeof obj.price === 'number') ? obj.price : 0
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
'      return "<div class=\\"row\\" data-k=\\""+k+"\\">"+iconHtml(x.type,x.icon)+',
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
'  load();',
'})();',
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
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
            server.listen(p, '127.0.0.1', function () {
                actualPort = server.address().port;
                console.log('[MToolItemBrowser] listening on http://127.0.0.1:' + actualPort);
            });
            return { ok: true, port: p, url: 'http://127.0.0.1:' + p };
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
        return {
            running: !!server,
            port: actualPort,
            url: actualPort ? ('http://127.0.0.1:' + actualPort) : null,
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
