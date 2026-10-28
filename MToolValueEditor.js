//=============================================================================
// MToolValueEditor.js  v2.0.0
// 游戏内数值编辑器（快速修改 + 锁定）—— 配置驱动，可跨游戏复用
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 游戏内数值快速编辑与锁定面板（F9 开关），支持外部注入配置
 * @author DSH Assistant
 * @help
 * 按 F9 打开/关闭面板。
 *
 * 本插件不硬编码任何游戏变量。条目来源优先级：
 *   1) 外部注入 window.__MTOOL_VALUE_EDITOR_CONFIG__
 *   2) localStorage 中用户自定义的条目
 *   3) 按变量名自动探测
 *   4) 空（此时用 A 键手动添加）
 *
 * 操作：
 *   ↑ / ↓     选择条目
 *   ← / →     调整当前值（按住 Shift 加速 10 倍）
 *   Enter     精确输入数值
 *   A         添加一个变量（输入变量 ID）
 *   D         删除当前条目
 *   L         锁定 / 解锁当前条目
 *   Esc / F9  关闭面板
 */

(function () {
    'use strict';

    if (window.MToolValueEditor && window.MToolValueEditor.__loaded) return;

    var PLUGIN = 'MToolValueEditor';
    var VERSION = '2.0.0';
    var CONFIG_GLOBAL = '__MTOOL_VALUE_EDITOR_CONFIG__';
    var LS_PREFIX = 'MToolValueEditor.';

    //=========================================================================
    // 游戏标识（用于隔离不同游戏的配置）
    //=========================================================================
    function gameTitle() {
        try {
            if (typeof $dataSystem !== 'undefined' && $dataSystem) {
                return $dataSystem.gameTitle || '';
            }
        } catch (err) { /* 忽略 */ }
        return document.title || '';
    }

    function gameId() {
        var t = gameTitle();
        var h = 0;
        for (var i = 0; i < t.length; i++) {
            h = ((h << 5) - h + t.charCodeAt(i)) | 0;
        }
        return 'g' + Math.abs(h).toString(36);
    }

    //=========================================================================
    // 外部配置
    //=========================================================================
    function getExternalConfig() {
        try {
            var c = window[CONFIG_GLOBAL];
            if (c && typeof c === 'object') return c;
        } catch (err) { /* 忽略 */ }
        return null;
    }

    /** 在配置文件里按游戏标题匹配预设 */
    function matchGameConfig(cfg, title) {
        if (!cfg || !cfg.games) return null;
        for (var k in cfg.games) {
            if (!Object.prototype.hasOwnProperty.call(cfg.games, k)) continue;
            var g = cfg.games[k];
            if (!g) continue;
            var ts = g.matchTitles || [];
            for (var i = 0; i < ts.length; i++) {
                if (title && String(title).indexOf(ts[i]) >= 0) {
                    return { gameId: k, title: title, entries: g.entries || [] };
                }
            }
        }
        return null;
    }

    /**
     * 没有外部注入时，自己去找配置文件（脱机启动也能用）。
     * 候选：游戏 js/plugins 下、游戏根目录、MTool 的 mtool-mods 目录。
     */
    function loadConfigFile() {
        try {
            if (typeof require !== 'function') return null;
            var fs = require('fs');
            var path = require('path');
            var candidates = [];
            try {
                if (typeof process !== 'undefined' && process.cwd) {
                    candidates.push(path.join(process.cwd(), 'js', 'plugins', 'MToolValueEditor.config.json'));
                    candidates.push(path.join(process.cwd(), 'MToolValueEditor.config.json'));
                    candidates.push(path.join(process.cwd(), '..', 'mtool-mods', 'MToolValueEditor.config.json'));
                }
            } catch (err) { /* 忽略 */ }
            candidates.push('D:/IDMDownloads/MTool_C68C688D/MTool/mtool-mods/MToolValueEditor.config.json');
            candidates.push('D:\\IDMDownloads\\MTool_C68C688D\\MTool\\mtool-mods\\MToolValueEditor.config.json');

            var title = gameTitle();
            for (var i = 0; i < candidates.length; i++) {
                if (!candidates[i]) continue;
                try {
                    if (!fs.existsSync(candidates[i])) continue;
                    var cfg = JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
                    var matched = matchGameConfig(cfg, title);
                    if (matched) return matched;
                } catch (err) { /* 试下一个 */ }
            }
        } catch (err) { /* 忽略 */ }
        return null;
    }

    //=========================================================================
    // 内置游戏预设（独立 mod 的核心：不依赖任何外部配置也能开箱即用）
    //=========================================================================
    var BUILTIN_PRESETS = [
        {
            gameId: 'unholy-maiden',
            matchTitles: ['不洁圣女', 'UnholyMaiden', 'Unholy Maiden', '亵渎之种'],
            entries: [
                { id: 69,  label: '等级 Lv',   step: 1,      min: 1, max: 9999 },
                { id: 68,  label: '等级经验',   step: 1000,   min: 0, max: 999999999 },
                { id: 271, label: '等级上限',   step: 10,     min: 1, max: 9999 },
                { special: 'actorHp', label: 'HP', step: 100, min: 0, max: 999999 },
                { special: 'actorMp', label: 'MP', step: 100, min: 0, max: 999999 },
                { special: 'actorTp', label: 'SP', step: 10,  min: 0, max: 100 },
                { id: 13, label: '药(显示值)', step: 1, min: 0, max: 9999 },
                { special: 'item', itemId: 21, label: '回复药(实际)', step: 1, min: 0, max: 99 },
                { id: 561, label: '紧身衣破损％', step: 1, min: 0, max: 100 },
                { id: 74,  label: '开锁加成A(技巧)', step: 5, min: 0, max: 100 },
                { id: 317, label: '开锁加成B(装备)', step: 5, min: 0, max: 100 },
                { special: 'oneShot', label: '⚡下次敌击必死', step: 1, min: 0, max: 1 },
                { special: 'gameSwitch', switchId: 262, label: 'CG闸门 开关#262' },
                // 【暂时禁用】commonEvent 强制演出实测无效，入口已移除；代码保留待修复
                // { special: 'commonEvent', eventId: 130, label: '强制CG演出(事件#130)' },
                { special: 'param', paramId: 0, label: '最大HP', step: 100, min: 1, max: 9999999 },
                { special: 'param', paramId: 1, label: '最大MP', step: 100, min: 0, max: 9999999 },
                { special: 'param', paramId: 2, label: '物理攻击', step: 10, min: 0, max: 99999 },
                { special: 'param', paramId: 3, label: '防御力', step: 10, min: 0, max: 99999 },
                { special: 'param', paramId: 4, label: '魔力', step: 10, min: 0, max: 99999 },
                { special: 'param', paramId: 5, label: '魔法抵抗', step: 10, min: 0, max: 99999 },
                { special: 'param', paramId: 6, label: '行动速度', step: 10, min: 0, max: 99999 },
                { special: 'param', paramId: 7, label: '祈力', step: 10, min: 0, max: 99999 },
                { special: 'xparam', paramId: 1, label: '回避率％', step: 5, min: 0, max: 999, scale: 100 },
                { special: 'xparam', paramId: 2, label: '致命率％', step: 5, min: 0, max: 999, scale: 100 },
                { special: 'sparam', paramId: 6, label: '物理伤害％', step: 5, min: 0, max: 999, scale: 100 },
                { special: 'sparam', paramId: 7, label: '魔法伤害％', step: 5, min: 0, max: 999, scale: 100 },
                { id: 41,  label: '体力', step: 1, min: 0, max: 9999, rankId: 461, thresholds: [4, 10, 15, 25, 35, 50] },
                { id: 42,  label: '筋力', step: 1, min: 0, max: 9999, rankId: 462, thresholds: [4, 14, 24, 34, 44, 69] },
                { id: 43,  label: '技術', step: 1, min: 0, max: 9999, rankId: 463, thresholds: [4, 14, 24, 34, 44, 69] },
                { id: 44,  label: '知性', step: 1, min: 0, max: 9999, rankId: 464, thresholds: [4, 14, 24, 34, 44, 69] },
                { id: 45,  label: '話術', step: 1, min: 0, max: 9999, rankId: 465, thresholds: [4, 10, 15, 25, 35, 50] },
                { id: 46,  label: '美貌', step: 1, min: 0, max: 9999, rankId: 466, thresholds: [4, 10, 15, 25, 35, 50] },
                { id: 202, label: '交涉能力', step: 1, min: 0, max: 9999 },
                { id: 260, label: '性的魅力', step: 1, min: 0, max: 9999 },
                { id: 201, label: '对人战力', step: 1, min: 0, max: 9999 },
                { id: 82,  label: '名声值', step: 1, min: 0, max: 9999 },
                { id: 47,  label: '欲望', step: 1, min: 0, max: 9999 },
                { id: 50,  label: '疲劳', step: 1, min: 0, max: 9999 },
                { id: 81,  label: '贞淑', step: 1, min: 0, max: 9999 },
                { id: 83,  label: '秩序 / 混沌', step: 1, min: 0, max: 9999 },
                { id: 203, label: '理性', step: 1, min: 0, max: 9999 },
                { id: 362, label: '淫靡', step: 1, min: 0, max: 9999 },
                { id: 567, label: '性技巧', step: 1, min: 0, max: 9999 },
                { id: 568, label: '敏感度', step: 1, min: 0, max: 9999 },
                { id: 569, label: '变态倾向', step: 1, min: 0, max: 9999 },
                { id: 49,  label: '金币(变量)', step: 10000, min: 0, max: 999999999 },
                { id: 51,  label: '以太', step: 100000, min: 0, max: 999999999 },
                { special: 'gold', label: '队伍金钱', step: 10000, min: 0, max: 999999999 }
            ]
        }
    ];

    function findBuiltinPreset(title) {
        for (var i = 0; i < BUILTIN_PRESETS.length; i++) {
            var p = BUILTIN_PRESETS[i];
            var ts = p.matchTitles || [];
            for (var j = 0; j < ts.length; j++) {
                if (title && String(title).indexOf(ts[j]) >= 0) return p;
            }
        }
        return null;
    }

    //=========================================================================
    // 自动探测规则（变量名关键词 → 条目）
    //=========================================================================
    var AUTO_RULES = [
        { re: /等级限制|等级上限|Lv上限|レベル上限/i, label: '等级上限', step: 10, min: 1, max: 9999 },
        { re: /^(等级|レベル|Level|Lv)$/i, label: '等级', step: 1, min: 1, max: 9999 },
        { re: /经验|経験|エーテル|以太|EXP/i, label: '经验/以太', step: 1000, min: 0, max: 999999999 },
        { re: /金钱|金币|所持金|お金|Gold|Money/i, label: '金钱', step: 10000, min: 0, max: 999999999 },
        { re: /欲望|欲求/i, label: '欲望', step: 1, min: 0, max: 9999 },
        { re: /疲劳|疲れ/i, label: '疲劳', step: 1, min: 0, max: 9999 },
        { re: /理智|正気|SAN/i, label: '理智', step: 1, min: 0, max: 9999 },
        { re: /贞淑|貞淑|贞操/i, label: '贞淑', step: 1, min: 0, max: 9999 },
        { re: /淫靡|淫乱/i, label: '淫靡', step: 1, min: 0, max: 9999 },
        { re: /敏感/i, label: '敏感度', step: 1, min: 0, max: 9999 },
        { re: /技巧|技術/i, label: '技巧', step: 1, min: 0, max: 9999 },
        { re: /变态|変態/i, label: '变态倾向', step: 1, min: 0, max: 9999 },
        { re: /秩序|混沌|カオス|ロウ/i, label: '秩序/混沌', step: 1, min: 0, max: 9999 },
        { re: /怀孕|妊娠/i, label: '怀孕次数', step: 1, min: 0, max: 99 },
        { re: /伴侣|パートナー/i, label: '伴侣', step: 1, min: 0, max: 9999 }
    ];

    function autoDetectEntries() {
        var result = [];
        var names = null;
        try {
            if (typeof $dataSystem !== 'undefined' && $dataSystem) {
                names = $dataSystem.variables;
            }
        } catch (err) { /* 忽略 */ }
        if (!names) return result;

        var used = {};
        for (var id = 1; id < names.length; id++) {
            var n = names[id];
            if (!n) continue;
            for (var i = 0; i < AUTO_RULES.length; i++) {
                if (AUTO_RULES[i].re.test(n)) {
                    var key = n + '|' + id;
                    if (used[key]) break;
                    used[key] = true;
                    result.push({
                        id: id,
                        label: n,
                        step: AUTO_RULES[i].step,
                        min: AUTO_RULES[i].min,
                        max: AUTO_RULES[i].max,
                        origin: 'auto'
                    });
                    break;
                }
            }
        }
        return result;
    }

    //=========================================================================
    // localStorage 持久化（按游戏隔离）
    //=========================================================================
    function lsKey(suffix) {
        return LS_PREFIX + gameId() + '.' + suffix;
    }

    function readSavedEntries() {
        try {
            var s = localStorage.getItem(lsKey('entries'));
            if (!s) return null;
            var arr = JSON.parse(s);
            if (Array.isArray(arr) && arr.length) return arr;
        } catch (err) { /* 忽略 */ }
        return null;
    }

    function saveEntries() {
        try {
            localStorage.setItem(lsKey('entries'), JSON.stringify(entries));
        } catch (err) { /* 忽略 */ }
    }

    function clearSavedEntries() {
        try {
            localStorage.removeItem(lsKey('entries'));
        } catch (err) { /* 忽略 */ }
    }

    //=========================================================================
    // 条目构建
    //=========================================================================
    function normalizeEntry(e) {
        if (!e || typeof e !== 'object') return null;
        var out = {
            id: (typeof e.id === 'number') ? e.id : Number(e.id),
            label: e.label || e.name || (e.id ? ('变量 #' + e.id) : '未命名'),
            step: (typeof e.step === 'number' && e.step > 0) ? e.step : 1,
            min: (typeof e.min === 'number') ? e.min : 0,
            max: (typeof e.max === 'number') ? e.max : 999999999,
            origin: e.origin || 'external'
        };
        if (e.special === 'gold') {
            out.special = 'gold';
            out.max = (typeof e.max === 'number') ? e.max : 999999999;
        } else if (e.special === 'actorHp' || e.special === 'actorMp' || e.special === 'actorTp') {
            // 角色属性条目（HP / MP / SP=TP）
            out.special = e.special;
            out.max = (typeof e.max === 'number') ? e.max : 999999999;
        } else if (e.special === 'item') {
            // 背包物品数量条目
            out.special = 'item';
            out.itemId = Number(e.itemId);
            if (!isFinite(out.itemId)) return null;
            out.max = (typeof e.max === 'number') ? e.max : 99;
        } else if (e.special === 'param' || e.special === 'xparam' || e.special === 'sparam') {
            // 派生属性覆盖（最大HP / 六维 / 回避率 / 伤害率 等）
            out.special = e.special;
            out.paramId = Number(e.paramId);
            if (!isFinite(out.paramId)) return null;
            out.scale = (typeof e.scale === 'number' && e.scale > 0) ? e.scale : 1;
            out.max = (typeof e.max === 'number') ? e.max : 99999;
        } else if (e.special === 'oneShot') {
            // 一次性开关：下次敌人攻击必中且归零
            out.special = 'oneShot';
            out.min = 0;
            out.max = 1;
        } else if (e.special === 'gameSwitch') {
            // 游戏开关（Enter 切换）
            out.special = 'gameSwitch';
            out.switchId = Number(e.switchId);
            if (!isFinite(out.switchId)) return null;
            out.min = 0;
            out.max = 1;
        } else if (e.special === 'commonEvent') {
            // 强制运行公共事件（Enter 执行）
            out.special = 'commonEvent';
            out.eventId = Number(e.eventId);
            if (!isFinite(out.eventId)) return null;
            out.min = 0;
            out.max = 1;
        } else if (!isFinite(out.id)) {
            return null;
        }
        // 能力等级：数值变量 + 等级字母变量 + 阈值表
        if (e.rankId != null && Array.isArray(e.thresholds) && e.thresholds.length) {
            out.rankId = Number(e.rankId);
            out.thresholds = e.thresholds.map(function (x) { return Number(x); });
        }
        return out;
    }

    function normalizeList(list) {
        var out = [];
        if (!Array.isArray(list)) return out;
        for (var i = 0; i < list.length; i++) {
            var n = normalizeEntry(list[i]);
            if (n) out.push(n);
        }
        return out;
    }

    var entries = [];
    var entriesSource = 'empty';
    var ready = false;

    function buildEntries() {
        var ext = getExternalConfig() || loadConfigFile();
        var saved = readSavedEntries();
        var gameKey = gameId();

        if (saved) {
            entries = normalizeList(saved);
            entriesSource = 'saved';
        } else if (ext) {
            var extEntries = null;
            // 支持两种结构：{entries:[...]} 或 {games:{<gameId>:[...]}}
            if (Array.isArray(ext.entries) && ext.entries.length) {
                extEntries = ext.entries;
            } else if (ext.games && Array.isArray(ext.games[gameKey])) {
                extEntries = ext.games[gameKey];
            } else if (ext.games && ext.games[gameTitle()]) {
                extEntries = ext.games[gameTitle()];
            }
            if (extEntries && extEntries.length) {
                entries = normalizeList(extEntries);
                entriesSource = 'external';
            }
        }

        // 独立 mod 兜底：内置预设（按游戏标题匹配）
        if (!entries.length) {
            var preset = findBuiltinPreset(gameTitle());
            if (preset && preset.entries && preset.entries.length) {
                entries = normalizeList(preset.entries);
                entriesSource = 'builtin';
            }
        }

        if (!entries.length) {
            var auto = autoDetectEntries();
            if (auto.length) {
                entries = auto;
                entriesSource = 'auto';
            } else {
                entries = [];
                entriesSource = 'empty';
            }
        }

        ready = true;
        return entries;
    }

    function ensureReady() {
        if (!ready) buildEntries();
        return entries;
    }

    function rebuild() {
        ready = false;
        return ensureReady();
    }

    //=========================================================================
    // 读写值
    //=========================================================================
    function keyOf(e) {
        if (e.special === 'item') return 'item' + e.itemId;
        if (e.special === 'param' || e.special === 'xparam' || e.special === 'sparam') {
            return e.special + ':' + e.paramId;
        }
        if (e.special) return e.special;   // gold / actorHp / actorMp / actorTp
        return 'v' + e.id;
    }

    /** 取道具对象 */
    function itemOf(e) {
        try {
            if (typeof $dataItems !== 'undefined' && $dataItems) return $dataItems[e.itemId] || null;
        } catch (err) { /* 忽略 */ }
        return null;
    }

    /** 当前队长（HP/MP/TP 等角色属性都取队长） */
    function leaderActor() {
        try {
            if (typeof $gameParty !== 'undefined' && $gameParty && $gameParty.leader) {
                return $gameParty.leader() || null;
            }
        } catch (err) { /* 忽略 */ }
        return null;
    }

    /** 条目的上限（HP/MP 取角色实时上限） */
    function maxOf(e) {
        if (e.special === 'actorHp') { var a = leaderActor(); return a ? a.mhp : 999999; }
        if (e.special === 'actorMp') { var a = leaderActor(); return a ? a.mmp : 999999; }
        if (e.special === 'actorTp') { return 100; }
        if (e.special === 'item') return (e.max == null) ? 99 : e.max;
        if (e.special === 'oneShot') return 1;
        if (e.special === 'gameSwitch' || e.special === 'commonEvent') return 1;
        return (e.max == null) ? 999999999 : e.max;
    }

    /** 是否为角色属性条目 */
    function isActorSpecial(e) {
        return e.special === 'actorHp' || e.special === 'actorMp' || e.special === 'actorTp';
    }

    function formatNumber(n) {
        if (typeof n !== 'number' || !isFinite(n)) return String(n);
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function clampValue(e, v) {
        v = Number(v);
        if (!isFinite(v)) v = 0;
        v = Math.round(v);
        var lo = (e.min == null) ? -999999999 : e.min;
        var hi = maxOf(e);
        return Math.max(lo, Math.min(hi, v));
    }

    //=========================================================================
    // 能力等级（F/E/D/C/B/A/S）—— 由数值按阈值派生
    //=========================================================================
    var RANK_TABLE = [
        { ch: 'F', color: 16 },
        { ch: 'E', color: 23 },
        { ch: 'D', color: 26 },
        { ch: 'C', color: 31 },
        { ch: 'B', color: 18 },
        { ch: 'A', color: 2 },
        { ch: 'S', color: 17 }
    ];

    /** 按阈值求出等级对象（thresholds 升序，超出最后一档即 S） */
    function rankFor(e, v) {
        var th = e.thresholds;
        if (!th || !th.length) return null;
        for (var i = 0; i < th.length; i++) {
            if (v <= th[i]) return RANK_TABLE[i] || RANK_TABLE[RANK_TABLE.length - 1];
        }
        return RANK_TABLE[th.length] || RANK_TABLE[RANK_TABLE.length - 1];
    }

    /** 生成游戏里使用的富文本等级串 */
    function rankText(rk) {
        if (!rk) return '';
        return '\\FS[30]\\c[' + rk.color + ']' + rk.ch + '\\c[0]\\FS[22] ';
    }

    function getValue(e) {
        if (e.special === 'gold') {
            return ($gameParty && $gameParty.gold) ? $gameParty.gold() : 0;
        }
        if (e.special === 'actorHp') { var a1 = leaderActor(); return a1 ? a1.hp : 0; }
        if (e.special === 'actorMp') { var a2 = leaderActor(); return a2 ? a2.mp : 0; }
        if (e.special === 'actorTp') { var a3 = leaderActor(); return a3 ? a3.tp : 0; }
        if (e.special === 'item') {
            var it0 = itemOf(e);
            return (it0 && $gameParty) ? $gameParty.numItems(it0) : 0;
        }
        if (e.special === 'param' || e.special === 'xparam' || e.special === 'sparam') {
            var la0 = leaderActor();
            if (!la0) return 0;
            var raw;
            if (e.special === 'param') raw = la0.param(e.paramId);
            else if (e.special === 'xparam') raw = la0.xparam(e.paramId);
            else raw = la0.sparam(e.paramId);
            return Math.round(raw * (e.scale || 1));
        }
        if (e.special === 'oneShot') return oneShotArmed() ? 1 : 0;
        if (e.special === 'gameSwitch') {
            try {
                return (typeof $gameSwitches !== 'undefined' && $gameSwitches && $gameSwitches.value(e.switchId)) ? 1 : 0;
            } catch (err) { return 0; }
        }
        if (e.special === 'commonEvent') return isCommonEventRunning() ? 1 : 0;
        if (typeof $gameVariables === 'undefined' || !$gameVariables) return 0;
        return $gameVariables.value(e.id);
    }

    function setValueInternal(e, v) {
        v = clampValue(e, v);
        var k = keyOf(e);
        if (Locks.map[k]) Locks.map[k].value = v;
        if (e.special === 'gold') {
            if (!$gameParty) return v;
            var cur = $gameParty.gold();
            if (v > cur) $gameParty.gainGold(v - cur);
            else if (v < cur) $gameParty.loseGold(cur - v);
        } else if (e.special === 'actorHp') {
            var ah = leaderActor(); if (ah) ah.setHp(v);
        } else if (e.special === 'actorMp') {
            var am = leaderActor(); if (am) am.setMp(v);
        } else if (e.special === 'actorTp') {
            var at = leaderActor(); if (at) at.setTp(v);
        } else if (e.special === 'item') {
            var it1 = itemOf(e);
            if (it1 && $gameParty) {
                var curIt = $gameParty.numItems(it1);
                if (v > curIt) $gameParty.gainItem(it1, v - curIt);
                else if (v < curIt) $gameParty.loseItem(it1, curIt - v);
            }
        } else if (e.special === 'param' || e.special === 'xparam' || e.special === 'sparam') {
            // 写入派生属性覆盖值（内部值 = 显示值 / scale）
            AttrOverrides[e.special][e.paramId] = v / (e.scale || 1);
        } else if (e.special === 'oneShot') {
            window.__MTE_ONE_SHOT__ = !!v;
        } else if (e.special === 'gameSwitch') {
            try {
                if (typeof $gameSwitches !== 'undefined' && $gameSwitches) {
                    $gameSwitches.setValue(e.switchId, !!v);
                }
            } catch (err) { /* 忽略 */ }
        } else if (e.special === 'commonEvent') {
            /* 数值写入无意义，执行由 Enter 触发 */
        } else if (typeof $gameVariables !== 'undefined' && $gameVariables) {
            $gameVariables.setValue(e.id, v);
            // 能力条目：改数值的同时按阈值重算并写入等级字母
            if (e.rankId != null && e.thresholds && e.thresholds.length) {
                var rk = rankFor(e, v);
                if (rk) $gameVariables.setValue(e.rankId, rankText(rk));
            }
        }
        return v;
    }

    //=========================================================================
    // 派生属性覆盖层（param / xparam / sparam）
    // 覆盖表挂在 window 上：热重载/多次加载共享同一份，可随时清空恢复
    //=========================================================================
    var AttrOverrides = (function () {
        if (!window.__MTE_ATTR_OVERRIDES__) {
            window.__MTE_ATTR_OVERRIDES__ = { param: {}, xparam: {}, sparam: {} };
        }
        return window.__MTE_ATTR_OVERRIDES__;
    })();

    /** 该条目当前是否处于「覆盖」状态 */
    function hasOverride(e) {
        if (e.special !== 'param' && e.special !== 'xparam' && e.special !== 'sparam') return false;
        return AttrOverrides[e.special][e.paramId] != null;
    }

    /** 是否为「属性覆盖层」实现的条目 */
    function isOverlayEntry(e) {
        return e.special === 'param' || e.special === 'xparam' || e.special === 'sparam';
    }

    /** 恢复单个条目到原始计算值，返回是否确实清除了覆盖 */
    function clearOverride(e) {
        if (e.special !== 'param' && e.special !== 'xparam' && e.special !== 'sparam') return false;
        if (AttrOverrides[e.special][e.paramId] == null) return false;
        delete AttrOverrides[e.special][e.paramId];
        return true;
    }

    /** 恢复全部属性覆盖，返回清除的条目数 */
    function clearAllOverrides() {
        var n = 0;
        ['param', 'xparam', 'sparam'].forEach(function (kind) {
            var m = AttrOverrides[kind];
            if (!m) return;
            for (var key in m) {
                if (Object.prototype.hasOwnProperty.call(m, key)) {
                    delete m[key];
                    n++;
                }
            }
        });
        return n;
    }

    if (typeof Game_BattlerBase !== 'undefined' && !Game_BattlerBase.prototype.__mteAttrHooked) {
        Game_BattlerBase.prototype.__mteAttrHooked = true;

        // 基础参数（0:mhp 1:mmp 2:atk 3:def 4:mat 5:mdf 6:agi 7:luk）
        var _baseParam = Game_BattlerBase.prototype.param;
        Game_BattlerBase.prototype.param = function (paramId) {
            var ov = AttrOverrides.param[paramId];
            if (ov != null && typeof this._actorId === 'number' && this._actorId === 1) return ov;
            return _baseParam.call(this, paramId);
        };

        // X 参数（1:eva 回避率 2:cri 致命率 …）
        var _baseXparam = Game_BattlerBase.prototype.xparam;
        Game_BattlerBase.prototype.xparam = function (xparamId) {
            var ov = AttrOverrides.xparam[xparamId];
            if (ov != null && typeof this._actorId === 'number' && this._actorId === 1) return ov;
            return _baseXparam.call(this, xparamId);
        };

        // S 参数（6:pdr 物理伤害 7:mdr 魔法伤害 …）
        var _baseSparam = Game_BattlerBase.prototype.sparam;
        Game_BattlerBase.prototype.sparam = function (sparamId) {
            var ov = AttrOverrides.sparam[sparamId];
            if (ov != null && typeof this._actorId === 'number' && this._actorId === 1) return ov;
            return _baseSparam.call(this, sparamId);
        };
    }

    //=========================================================================
    // 必死一击：下一次敌人对玩家的攻击 —— 强制命中 + 伤害 = 目标当前 HP
    //=========================================================================
    function oneShotArmed() {
        return !!window.__MTE_ONE_SHOT__;
    }

    function isEnemyAttackOnActor(action, target) {
        try {
            return action.isForOpponent() && target && typeof target.isActor === 'function' && target.isActor();
        } catch (err) {
            return false;
        }
    }

    if (typeof Game_Action !== 'undefined' && !Game_Action.prototype.__mteOneShotHooked) {
        Game_Action.prototype.__mteOneShotHooked = true;

        // 命中率拉满：missed = Math.random() >= itemHit → 1 时永不 miss
        var _itemHit = Game_Action.prototype.itemHit;
        Game_Action.prototype.itemHit = function (target) {
            if (oneShotArmed() && isEnemyAttackOnActor(this, target)) return 1;
            return _itemHit.call(this, target);
        };

        // 回避率归零：evaded = Math.random() < itemEva → 0 时永不闪避
        var _itemEva = Game_Action.prototype.itemEva;
        Game_Action.prototype.itemEva = function (target) {
            if (oneShotArmed() && isEnemyAttackOnActor(this, target)) return 0;
            return _itemEva.call(this, target);
        };

        // 伤害改为「目标当前 HP」→ 一次归零
        var _executeHpDamage = Game_Action.prototype.executeHpDamage;
        Game_Action.prototype.executeHpDamage = function (target, value) {
            if (oneShotArmed() && isEnemyAttackOnActor(this, target)) {
                value = target.hp;
                window.__MTE_ONE_SHOT__ = false;   // 一次性，用完即关
            }
            return _executeHpDamage.call(this, target, value);
        };
    }

    //=========================================================================
    // 强制公共事件演出（手动驱动 Game_Interpreter）
    // 说明：MZ 战斗中 $gameTemp.reserveCommonEvent 不会自动执行，需要自己 update
    //=========================================================================
    var _ceInterp = null;

    function runCommonEvent(eventId) {
        if (typeof Game_Interpreter === 'undefined') return false;
        var ev = (typeof $dataCommonEvents !== 'undefined' && $dataCommonEvents) ? $dataCommonEvents[eventId] : null;
        if (!ev || !ev.list || !ev.list.length) return false;
        if (_ceInterp) return false;   // 已有演出在跑
        try {
            _ceInterp = new Game_Interpreter();
            _ceInterp.setup(ev.list, 0);
            return true;
        } catch (err) {
            _ceInterp = null;
            return false;
        }
    }

    function updateCommonEventInterp() {
        if (!_ceInterp) return;
        try {
            _ceInterp.update();
            if (!_ceInterp._list || _ceInterp._index >= _ceInterp._list.length) {
                _ceInterp = null;
            }
        } catch (err) {
            _ceInterp = null;   // 出现异常则终止，绝不影响主循环
        }
    }

    function isCommonEventRunning() {
        return !!_ceInterp;
    }

    //=========================================================================
    // 锁定
    //=========================================================================
    var Locks = {
        map: {},
        isLocked: function (e) { return !!this.map[keyOf(e)]; },
        toggle: function (e) {
            var k = keyOf(e);
            if (this.map[k]) {
                delete this.map[k];
            } else {
                this.map[k] = { value: getValue(e), label: e.label };
            }
            this.save();
            return !!this.map[k];
        },
        save: function () {
            try {
                localStorage.setItem(PLUGIN + '.locks.' + gameId(), JSON.stringify(this.map));
            } catch (err) { /* 忽略 */ }
        },
        load: function () {
            try {
                var s = localStorage.getItem(PLUGIN + '.locks.' + gameId());
                if (s) this.map = JSON.parse(s) || {};
            } catch (err) { this.map = {}; }
        },
        enforce: function () {
            if (typeof $gameVariables === 'undefined' || !$gameVariables) return;
            for (var k in this.map) {
                if (!Object.prototype.hasOwnProperty.call(this.map, k)) continue;
                var target = this.map[k].value;
                try {
                    if (k === 'gold') {
                        if (typeof $gameParty !== 'undefined' && $gameParty && $gameParty.gold() !== target) {
                            $gameParty._gold = target;
                        }
                    } else if (k === 'actorHp' || k === 'actorMp' || k === 'actorTp') {
                        var la = leaderActor();
                        if (la) {
                            if (k === 'actorHp' && la.hp !== target) la.setHp(target);
                            else if (k === 'actorMp' && la.mp !== target) la.setMp(target);
                            else if (k === 'actorTp' && la.tp !== target) la.setTp(target);
                        }
                    } else if (k.indexOf('item') === 0) {
                        var iid = Number(k.slice(4));
                        var iobj = (typeof $dataItems !== 'undefined' && $dataItems) ? $dataItems[iid] : null;
                        if (iobj && $gameParty) {
                            var icur = $gameParty.numItems(iobj);
                            if (icur !== target) {
                                if (target > icur) $gameParty.gainItem(iobj, target - icur);
                                else $gameParty.loseItem(iobj, icur - target);
                            }
                        }
                    } else {
                        var id = Number(k.slice(1));
                        if ($gameVariables && $gameVariables.value(id) !== target) {
                            $gameVariables.setValue(id, target);
                        }
                    }
                } catch (err) { /* 单项失败不影响其它 */ }
            }
        }
    };

    //=========================================================================
    // 拦截写入
    //=========================================================================
    if (typeof Game_Variables !== 'undefined') {
        var _setValue = Game_Variables.prototype.setValue;
        Game_Variables.prototype.setValue = function (variableId, value) {
            var lock = Locks.map['v' + variableId];
            if (lock) value = lock.value;
            _setValue.call(this, variableId, value);
        };
    }

    if (typeof Game_Party !== 'undefined') {
        var _gainGold = Game_Party.prototype.gainGold;
        Game_Party.prototype.gainGold = function (amount) {
            _gainGold.call(this, amount);
            if (Locks.map['gold']) this._gold = Locks.map['gold'].value;
        };
        var _loseGold = Game_Party.prototype.loseGold;
        Game_Party.prototype.loseGold = function (amount) {
            _loseGold.call(this, amount);
            if (Locks.map['gold']) this._gold = Locks.map['gold'].value;
        };
    }

    var _lockTick = 0;
    if (typeof SceneManager !== 'undefined') {
        var _SceneManager_update = SceneManager.update;
        SceneManager.update = function () {
            // 必须原样转发全部参数（deltaTime）：
            // 原 update 用 determineRepeatNumber(deltaTime) 计算每帧更新次数，
            // 丢参数会得到 NaN → 每帧更新 0 次 → 场景永不切换（黑屏）。
            _SceneManager_update.apply(this, arguments);
            _lockTick++;
            try { updateCommonEventInterp(); } catch (err) { /* 演出异常不影响主循环 */ }
            if (_lockTick % 20 === 0) {
                try { Locks.enforce(); } catch (err) { /* 绝不影响游戏主循环 */ }
            }
        };
    }

    //=========================================================================
    // 列表窗口
    //=========================================================================
    function Window_MtoolValueList() {
        this.initialize.apply(this, arguments);
    }
    Window_MtoolValueList.prototype = Object.create(Window_Selectable.prototype);
    Window_MtoolValueList.prototype.constructor = Window_MtoolValueList;

    Window_MtoolValueList.prototype.initialize = function (rect) {
        Window_Selectable.prototype.initialize.call(this, rect);
        this._items = entries;
        this._editingIndex = -1;
        this._editBuffer = '';
        this.refresh();
    };

    Window_MtoolValueList.prototype.maxItems = function () {
        return this._items ? this._items.length : 0;
    };
    Window_MtoolValueList.prototype.maxCols = function () { return 1; };
    Window_MtoolValueList.prototype.itemHeight = function () {
        return this.lineHeight() + 14;
    };

    // 单列列表：左右键不移动光标（改由 Scene.updateInput 调整数值）
    Window_MtoolValueList.prototype.cursorLeft = function () {};
    Window_MtoolValueList.prototype.cursorRight = function () {};

    // 关键：禁用窗口自带的输入处理，全部输入交给 document keydown（单一输入源，避免重复）
    Window_MtoolValueList.prototype.processCursorMove = function () {};
    Window_MtoolValueList.prototype.processHandling = function () {};

    Window_MtoolValueList.prototype.setItems = function (list) {
        this._items = list;
        this.refresh();
        if (this.index() >= this.maxItems()) this.select(Math.max(0, this.maxItems() - 1));
    };

    Window_MtoolValueList.prototype.setEditing = function (index, buffer) {
        this._editingIndex = index;
        this._editBuffer = buffer;
        this.refresh();
    };

    Window_MtoolValueList.prototype.clearEditing = function () {
        this._editingIndex = -1;
        this._editBuffer = '';
        this.refresh();
    };

    Window_MtoolValueList.prototype.drawItem = function (index) {
        var e = this._items[index];
        if (!e) return;
        var rect = this.itemRect(index);
        var locked = Locks.isLocked(e);
        var value = getValue(e);
        var editing = (this._editingIndex === index);
        var pad = 12;
        var rankInfo = (e.rankId != null) ? rankFor(e, value) : null;

        this.changeTextColor(locked ? '#ffd166' : '#ffffff');
        var nameX = rect.x + pad;
        var nameWidth = rect.width - 360;
        // 覆盖层实现的项（param/xparam/sparam）加图标标识：◇ 未覆盖 / ◆ 已覆盖
        if (isOverlayEntry(e)) {
            this.changeTextColor(hasOverride(e) ? '#7fd7ff' : '#6f6f6f');
            this.drawText(hasOverride(e) ? '◆' : '◇', nameX, rect.y, 24, 'left');
            nameX += 26;
            nameWidth -= 26;
        }
        this.changeTextColor(locked ? '#ffd166' : '#ffffff');
        var nameText = e.label + (e.id ? '  (#' + e.id + ')' : '');
        this.drawText(nameText, nameX, rect.y, nameWidth, 'left');

        var valueRight = rect.width - pad - 64;
        var valueText;
        if (editing) {
            valueText = (this._editBuffer === '' ? '0' : this._editBuffer) + '_';
            this.changeTextColor('#7fd7ff');
            this.drawText(valueText, rect.x, rect.y, valueRight, 'right');
        } else if (rankInfo) {
            // 等级字母（用游戏色板颜色）在最右，数值在其左
            // 注意：MZ 1.9 已移除 Window_Base#textColor，必须用 ColorManager.textColor
            var rankCss = '#ffffff';
            try {
                if (typeof ColorManager !== 'undefined' && typeof ColorManager.textColor === 'function') {
                    rankCss = ColorManager.textColor(rankInfo.color);
                }
            } catch (err) { /* 保底白色 */ }
            this.changeTextColor(rankCss);
            this.drawText(rankInfo.ch, rect.x, rect.y, valueRight, 'right');
            this.changeTextColor(locked ? '#8cff8c' : '#ffe28a');
            this.drawText(formatNumber(value), rect.x, rect.y, valueRight - 52, 'right');
        } else if (e.special === 'oneShot') {
            var armed = oneShotArmed();
            this.changeTextColor(armed ? '#ff6b6b' : '#8a8a8a');
            this.drawText(armed ? '已武装（下次必死）' : '待命', rect.x, rect.y, valueRight, 'right');
        } else if (e.special === 'gameSwitch') {
            var swOn = getValue(e) === 1;
            this.changeTextColor(swOn ? '#8cff8c' : '#8a8a8a');
            this.drawText(swOn ? 'ON' : 'OFF', rect.x, rect.y, valueRight, 'right');
        } else if (e.special === 'commonEvent') {
            var running = isCommonEventRunning();
            this.changeTextColor(running ? '#ffd166' : '#7fd7ff');
            this.drawText(running ? '演出中…' : 'Enter 执行', rect.x, rect.y, valueRight, 'right');
        } else {
            valueText = formatNumber(value);
            if (isActorSpecial(e) || e.special === 'item') valueText += ' / ' + formatNumber(maxOf(e));
            var overridden = hasOverride(e);
            this.changeTextColor(overridden ? '#7fd7ff' : (locked ? '#8cff8c' : '#ffe28a'));
            this.drawText(valueText, rect.x, rect.y, valueRight, 'right');
        }

        if (locked) {
            this.changeTextColor('#8cff8c');
            this.drawText('[锁]', rect.x, rect.y, rect.width - pad, 'right');
        }
    };

    //=========================================================================
    // 场景
    //=========================================================================
    function Scene_MtoolPanel() {
        this.initialize.apply(this, arguments);
    }
    Scene_MtoolPanel.prototype = Object.create(Scene_MenuBase.prototype);
    Scene_MtoolPanel.prototype.constructor = Scene_MtoolPanel;

    Scene_MtoolPanel.prototype.create = function () {
        Scene_MenuBase.prototype.create.call(this);
        this.__mtePanel = true;     // 面板实例标记：用于幂等判断，防止重复叠层
        this._mode = 'browse';      // browse | editValue | addVar
        this._editBuffer = '';
        this._refreshTick = 0;
        this.createHelpWindow();
        this.createListWindow();
        this.updateHelpText();
    };

    Scene_MtoolPanel.prototype.createBackground = function () {
        Scene_MenuBase.prototype.createBackground.call(this);
        if (this._backgroundSprite) {
            this._backgroundSprite.filters = [];
            var bmp = new Bitmap(Graphics.boxWidth, Graphics.boxHeight);
            bmp.fillRect(0, 0, Graphics.boxWidth, Graphics.boxHeight, 'rgba(0,0,0,0.78)');
            this._backgroundSprite.bitmap = bmp;
            this._backgroundSprite.setFrame(0, 0, Graphics.boxWidth, Graphics.boxHeight);
            this._backgroundSprite.opacity = 255;
        }
    };

    Scene_MtoolPanel.prototype.createHelpWindow = function () {
        var rect = new Rectangle(0, Graphics.boxHeight - 96, Graphics.boxWidth, 96);
        this._helpWindow = new Window_Help(rect);
        this.addWindow(this._helpWindow);
    };

    Scene_MtoolPanel.prototype.createListWindow = function () {
        var w = Math.min(880, Graphics.boxWidth - 40);
        var h = Math.max(200, Graphics.boxHeight - 210);
        var x = Math.floor((Graphics.boxWidth - w) / 2);
        var y = 86;
        this._listWindow = new Window_MtoolValueList(new Rectangle(x, y, w, h));
        this.addWindow(this._listWindow);
        this._listWindow.activate();
        this._listWindow.select(0);
        this._listWindow.setHandler('ok', this.beginEditValue.bind(this));
        this._listWindow.setHandler('cancel', this.popScene.bind(this));
    };

    Scene_MtoolPanel.prototype.updateHelpText = function () {
        if (!this._helpWindow) return;
        var srcText = { 'external': '外部注入', 'builtin': '内置预设', 'saved': '本地保存', 'auto': '自动探测', 'empty': '空' }[entriesSource] || entriesSource;
        var line1 = '↑↓ 选择  ←→ 调整  Enter 输入  A 添加  D 删除  L 锁定  R 恢复(Shift 全部)  Esc/F9 关闭';
        var line2 = '游戏：' + (gameTitle() || '未知') + '    条目来源：' + srcText + '    共 ' + entries.length + ' 项    ◇/◆=属性覆盖层项(◆已改，R 恢复)';
        if (this._mode === 'addVar') {
            line2 = '输入变量 ID：' + (this._editBuffer || '') + '_     Enter 确认    Esc 取消';
        } else if (this._mode === 'editValue') {
            line2 = '输入数值：' + (this._editBuffer || '') + '_     Enter 确认    Esc 取消';
        }
        this._helpWindow.setText(line1 + '\n' + line2);
    };

    Scene_MtoolPanel.prototype.update = function () {
        Scene_MenuBase.prototype.update.call(this);
        this._refreshTick++;
        if (this._listWindow && this._refreshTick % 12 === 0) this._listWindow.refresh();
    };

    // 输入全部由 document keydown 统一处理（MZ 1.9 不调用 Scene#updateInput，且窗口输入已禁用）
    Scene_MtoolPanel.prototype.updateInput = function () {
        Scene_MenuBase.prototype.updateInput.call(this);
    };

    Scene_MtoolPanel.prototype.onRawKeyDown = function (ev) {
        var key = ev.key;

        // ---------- 输入模式 ----------
        if (this._mode === 'editValue' || this._mode === 'addVar') {
            if (key.length === 1 && key >= '0' && key <= '9') {
                if (this._editFresh) {
                    this._editBuffer = '';
                    this._editFresh = false;
                }
                if (this._editBuffer.length < 9) this._editBuffer += key;
            } else if (key === 'Backspace') {
                this._editFresh = false;
                this._editBuffer = this._editBuffer.slice(0, -1);
            } else if (key === 'Enter') {
                this.commitInput();
                return;
            } else if (key === 'Escape') {
                this.cancelInput();
                return;
            } else {
                return;
            }
            this.updateHelpText();
            if (this._mode === 'editValue') {
                this._listWindow.setEditing(this._listWindow.index(), this._editBuffer);
            }
            ev.preventDefault();
            return;
        }

        // ---------- 浏览模式 ----------
        // 窗口自带输入已禁用（processCursorMove / processHandling 置空），
        // 这里统一处理全部按键 —— 单一输入源，不会出现一次跳两格。
        var index = this._listWindow.index();
        switch (key) {
            case 'ArrowUp':
                this._listWindow.cursorUp(true);
                SoundManager.playCursor();
                ev.preventDefault();
                break;
            case 'ArrowDown':
                this._listWindow.cursorDown(true);
                SoundManager.playCursor();
                ev.preventDefault();
                break;
            case 'ArrowLeft':
                this.adjustValue(index, -1, ev.repeat);
                ev.preventDefault();
                break;
            case 'ArrowRight':
                this.adjustValue(index, 1, ev.repeat);
                ev.preventDefault();
                break;
            case 'Enter':
            case 'z':
            case 'Z':
                this.beginEditValue();
                ev.preventDefault();
                break;
            case 'a':
            case 'A':
                this.beginAddVar();
                ev.preventDefault();
                break;
            case 'd':
            case 'D':
                this.removeCurrent();
                ev.preventDefault();
                break;
            case 'l':
            case 'L':
                this.toggleLock();
                ev.preventDefault();
                break;
            case 'r':
            case 'R':
                this.restoreCurrent(Input.isPressed('shift'));
                ev.preventDefault();
                break;
            case 'Escape':
                this.popScene();
                ev.preventDefault();
                break;
            default:
                break;
        }
    };

    Scene_MtoolPanel.prototype.adjustValue = function (index, dir, isRepeat) {
        var e = entries[index];
        if (!e) return;
        var step = e.step || 1;
        if (Input.isPressed('shift')) step *= 10;
        if (isRepeat) step *= 3;
        setValueInternal(e, getValue(e) + dir * step);
        this._listWindow.refresh();
        SoundManager.playCursor();
    };

    Scene_MtoolPanel.prototype.beginEditValue = function () {
        var e = entries[this._listWindow.index()];
        if (!e) return;
        // 一次性开关条目：回车直接切换，不进入数字输入
        if (e.special === 'oneShot') {
            window.__MTE_ONE_SHOT__ = !oneShotArmed();
            this._listWindow.refresh();
            SoundManager.playOk();
            return;
        }
        // 游戏开关：回车切换 ON/OFF
        if (e.special === 'gameSwitch') {
            setValueInternal(e, getValue(e) ? 0 : 1);
            this._listWindow.refresh();
            SoundManager.playOk();
            return;
        }
        // 强制公共事件：回车执行
        if (e.special === 'commonEvent') {
            var started = runCommonEvent(e.eventId);
            this._listWindow.refresh();
            if (started) SoundManager.playEquip();
            else SoundManager.playBuzzer();
            return;
        }
        this._mode = 'editValue';
        this._editBuffer = String(getValue(e));
        this._editFresh = true;   // 首次输入数字时替换当前值，而不是追加
        this._listWindow.setEditing(this._listWindow.index(), this._editBuffer);
        this.updateHelpText();
        SoundManager.playOk();
    };

    Scene_MtoolPanel.prototype.beginAddVar = function () {
        this._mode = 'addVar';
        this._editBuffer = '';
        this._editFresh = true;
        this.updateHelpText();
        SoundManager.playOk();
    };

    Scene_MtoolPanel.prototype.commitInput = function () {
        if (this._mode === 'editValue') {
            var e = entries[this._listWindow.index()];
            if (e) {
                var v = parseInt(this._editBuffer, 10);
                if (!isNaN(v)) setValueInternal(e, v);
            }
            this._mode = 'browse';
            this._listWindow.clearEditing();
        } else if (this._mode === 'addVar') {
            var id = parseInt(this._editBuffer, 10);
            if (!isNaN(id) && id > 0) {
                var exists = false;
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].id === id && !entries[i].special) { exists = true; break; }
                }
                if (!exists) {
                    var label = '变量 #' + id;
                    try {
                        if (typeof $dataSystem !== 'undefined' && $dataSystem.variables[id]) {
                            label = $dataSystem.variables[id];
                        }
                    } catch (err) { /* 忽略 */ }
                    entries.push({
                        id: id, label: label, step: 1, min: 0, max: 999999999, origin: 'manual'
                    });
                    entriesSource = 'saved';
                    saveEntries();
                    this._listWindow.setItems(entries);
                    this._listWindow.select(entries.length - 1);
                }
            }
            this._mode = 'browse';
        }
        if (this._listWindow) this._listWindow.activate();
        this.updateHelpText();
        SoundManager.playOk();
    };

    Scene_MtoolPanel.prototype.cancelInput = function () {
        this._mode = 'browse';
        this._editBuffer = '';
        this._listWindow.clearEditing();
        if (this._listWindow) this._listWindow.activate();
        this.updateHelpText();
        SoundManager.playCancel();
    };

    Scene_MtoolPanel.prototype.removeCurrent = function () {
        var index = this._listWindow.index();
        var e = entries[index];
        if (!e) return;
        entries.splice(index, 1);
        entriesSource = 'saved';
        saveEntries();
        this._listWindow.setItems(entries);
        this._listWindow.select(Math.min(index, Math.max(0, entries.length - 1)));
        this.updateHelpText();
        SoundManager.playCancel();
    };

    // 关闭面板时清空输入状态，避免按键残留在战斗等场景
    Scene_MtoolPanel.prototype.popScene = function () {
        try { if (typeof Input !== 'undefined' && Input.clear) Input.clear(); } catch (err) { /* 忽略 */ }
        Scene_MenuBase.prototype.popScene.call(this);
    };

    // R 恢复：单项恢复当前覆盖；配合 Shift 恢复全部覆盖
    Scene_MtoolPanel.prototype.restoreCurrent = function (all) {
        if (all) {
            clearAllOverrides();
            this._listWindow.refresh();
            this.updateHelpText();
            SoundManager.playCancel();
            return;
        }
        var e = entries[this._listWindow.index()];
        if (!e) return;
        clearOverride(e);
        this._listWindow.refresh();
        SoundManager.playCancel();
    };

    Scene_MtoolPanel.prototype.toggleLock = function () {
        var e = entries[this._listWindow.index()];
        if (!e) return;
        var locked = Locks.toggle(e);
        this._listWindow.refresh();
        if (locked) SoundManager.playEquip();
        else SoundManager.playCancel();
    };

    //=========================================================================
    // 开关面板
    //=========================================================================
    /** 是否为面板场景（兼容热重载产生的旧实例：无标记时按类名判断） */
    function isPanelScene(s) {
        return !!(s && (s.__mtePanel || (s.constructor && s.constructor.name === 'Scene_MtoolPanel')));
    }

    /** 是否有面板正在创建中（已 push、尚未切换） */
    function isPanelPending() {
        return isPanelScene(SceneManager._nextScene);
    }

    /** 清掉场景栈里遗留的面板类，返回清理数量 */
    function prunePanelStack() {
        var stack = SceneManager._stack || [];
        var out = [];
        for (var i = 0; i < stack.length; i++) {
            var cls = stack[i];
            if (cls && cls.name === 'Scene_MtoolPanel') continue;
            out.push(cls);
        }
        if (out.length !== stack.length) {
            SceneManager._stack = out;
        }
        return stack.length - out.length;
    }

    function canOpenPanel() {
        if (typeof $gameVariables === 'undefined' || !$gameVariables) return false;
        var scene = SceneManager._scene;
        if (!scene) return false;
        // 战斗中同样允许打开（战斗会暂停，关闭后恢复）
        if (typeof Scene_Title !== 'undefined' && scene instanceof Scene_Title) return false;
        if (typeof Scene_Boot !== 'undefined' && scene instanceof Scene_Boot) return false;
        return true;
    }

    function togglePanel() {
        var scene = SceneManager._scene;
        if (isPanelScene(scene)) {
            scene.popScene();
            return;
        }
        if (isPanelPending()) return;   // 已经在打开中，避免重复 push
        if (!canOpenPanel()) return;
        prunePanelStack();              // 只清理历史遗留的面板层，不动游戏场景
        ensureReady();
        // 清空输入状态，避免残留在战斗等场景里误触发
        try { if (typeof Input !== 'undefined' && Input.clear) Input.clear(); } catch (err) { /* 忽略 */ }
        SceneManager.push(Scene_MtoolPanel);
    }

    var keydownHandler = function (ev) {
        if (ev.key === 'F9') {
            ev.preventDefault();
            togglePanel();
            return;
        }
        var scene = SceneManager._scene;
        if (isPanelScene(scene)) {
            scene.onRawKeyDown(ev);
        }
    };

    // 重复加载时先摘掉旧监听器，避免叠加触发
    try {
        if (window.__MTE_KEYDOWN_HANDLER__) {
            document.removeEventListener('keydown', window.__MTE_KEYDOWN_HANDLER__, true);
        }
    } catch (err) { /* 忽略 */ }
    window.__MTE_KEYDOWN_HANDLER__ = keydownHandler;
    document.addEventListener('keydown', keydownHandler, true);

    //=========================================================================
    // 初始化（$dataSystem 可能尚未就绪，延迟到第一次使用）
    //=========================================================================
    function tryInitLocks() {
        try {
            if (typeof $gameVariables !== 'undefined' && $gameVariables) Locks.load();
        } catch (err) { /* 忽略 */ }
    }
    tryInitLocks();

    //=========================================================================
    // 对外 API（供外部注入的 loader / MTool 调用）
    //=========================================================================
    window.MToolValueEditor = {
        __loaded: true,
        version: VERSION,

        /** 打开面板（幂等：已打开/打开中则忽略，并清理历史遗留层） */
        open: function () {
            var cur = SceneManager._scene;
            if (isPanelScene(cur)) return;
            if (isPanelPending()) return;
            prunePanelStack();
            ensureReady();
            try { if (typeof Input !== 'undefined' && Input.clear) Input.clear(); } catch (err) { /* 忽略 */ }
            SceneManager.push(Scene_MtoolPanel);
        },
        /** 关闭面板（只关掉自己这一层） */
        close: function () {
            var cur = SceneManager._scene;
            if (isPanelScene(cur)) cur.popScene();
        },
        /** 切换 */
        toggle: togglePanel,

        /** 当前条目（会自动触发懒加载） */
        getEntries: function () { ensureReady(); return entries; },
        /** 当前条目来源：external / saved / auto / empty */
        getSource: function () { ensureReady(); return entriesSource; },

        /** 按变量 ID 或 special 名取条目；param 类可用 'param:2' 形式精确定位 */
        getEntry: function (entryId) {
            ensureReady();
            var wantedId = null;
            if (typeof entryId === 'string' && entryId.indexOf(':') > 0) {
                var parts = entryId.split(':');
                wantedId = Number(parts[1]);
                entryId = parts[0];
            }
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (e.id === entryId || e.special === entryId) {
                    if (wantedId == null || e.paramId === wantedId) return e;
                }
            }
            return null;
        },

        /** 按变量 ID 设值（会自动同步等级字母），返回实际写入值 */
        setValue: function (entryId, value) {
            ensureReady();
            var e = this.getEntry(entryId);
            if (!e) return null;
            var r = setValueInternal(e, value);
            var scene = SceneManager._scene;
            if (isPanelScene(scene)) scene._listWindow.refresh();
            return r;
        },

        /** 计算某条目在给定数值下的等级字母 */
        rankOf: function (entryId, value) {
            ensureReady();
            var e = this.getEntry(entryId);
            if (!e || e.rankId == null) return null;
            var rk = rankFor(e, (value == null) ? getValue(e) : value);
            return rk ? rk.ch : null;
        },

        /** 该属性条目是否处于覆盖状态（● 标记） */
        hasOverride: function (entryId) {
            ensureReady();
            var e = this.getEntry(entryId);
            return e ? hasOverride(e) : false;
        },

        /** 恢复单个属性条目到原始计算值 */
        clearOverride: function (entryId) {
            ensureReady();
            var e = this.getEntry(entryId);
            return e ? clearOverride(e) : false;
        },

        /** 恢复全部属性覆盖，返回清除数量 */
        clearAllOverrides: function () {
            return clearAllOverrides();
        },
        getGameId: gameId,
        getGameTitle: gameTitle,

        /** 整体替换条目（外部注入用） */
        setEntries: function (list) {
            entries = normalizeList(list);
            entriesSource = 'external';
            ready = true;
            saveEntries();
            var scene = SceneManager._scene;
            if (isPanelScene(scene)) {
                scene._listWindow.setItems(entries);
                scene.updateHelpText();
            }
            return entries.length;
        },

        /** 追加单条 */
        addEntry: function (entry) {
            var n = normalizeEntry(entry);
            if (!n) return false;
            entries.push(n);
            entriesSource = 'saved';
            saveEntries();
            var scene = SceneManager._scene;
            if (isPanelScene(scene)) {
                scene._listWindow.setItems(entries);
                scene.updateHelpText();
            }
            return true;
        },

        /** 移除条目 */
        removeEntry: function (id) {
            for (var i = entries.length - 1; i >= 0; i--) {
                if (entries[i].id === id) entries.splice(i, 1);
            }
            entriesSource = 'saved';
            saveEntries();
            return entries.length;
        },

        /** 导出当前配置（可发给别的游戏用） */
        exportConfig: function () {
            return {
                gameId: gameId(),
                title: gameTitle(),
                entries: entries.map(function (e) {
                    return {
                        id: e.id, label: e.label, step: e.step,
                        min: e.min, max: e.max, special: e.special,
                        rankId: e.rankId, thresholds: e.thresholds
                    };
                })
            };
        },

        /** 导入配置 */
        importConfig: function (cfg) {
            if (!cfg) return 0;
            var list = cfg.entries || (cfg.games && cfg.games[cfg.gameId]) || [];
            return this.setEntries(list);
        },

        /** 清掉本地保存，回到外部/自动探测 */
        resetToDefault: function () {
            clearSavedEntries();
            rebuild();
            var scene = SceneManager._scene;
            if (isPanelScene(scene)) {
                scene._listWindow.setItems(entries);
                scene.updateHelpText();
            }
            return entriesSource;
        },

        /** 重新探测 */
        reload: function () {
            rebuild();
            return entries.length;
        },

        locks: Locks,
        Scene: Scene_MtoolPanel
    };

    console.log('[MToolValueEditor] v' + VERSION + ' loaded (' + (window[CONFIG_GLOBAL] ? 'external config present' : 'no external config') + ')');
})();
