//@GlobalAutoLoad @AutoLoad
//=============================================================================
// mtool-value-editor-loader.js
// MTool 脚本 mod（工具内运行）：把 MToolValueEditor 插件注入当前游戏
//=============================================================================
//
// 作用：
//   1. 每次「游戏附加」时自动执行（@AutoLoad），把插件注入游戏 v8 环境；
//   2. 读取同目录 MToolValueEditor.config.json，按游戏标题/目录匹配预设；
//   3. 把匹配到的条目配置注入 window.__MTOOL_VALUE_EDITOR_CONFIG__；
//   4. 插件已存在时只刷新配置，不重复注册。
//
// 关键点：本脚本跑在「工具内」（有 Node 的 require/fs），
//        通过 MTool 注入的 v8Eval(code) 在游戏 v8 环境执行代码。
//
// 安装：MTool → MCenter → 脚本 → 新建，粘贴本文件全文（首行必须保留）。
//=============================================================================

;(function () {
    'use strict';

    var LOG_PREFIX = '[mtool-value-editor]';
    var ROOT = (typeof globalThis !== 'undefined') ? globalThis : this;

    function log(msg) {
        try { console.log(LOG_PREFIX + ' ' + msg); } catch (err) { /* 忽略 */ }
    }

    //-------------------------------------------------------------------------
    // 0. 该脚本依赖的工具能力
    //-------------------------------------------------------------------------
    var MOD_DIR_CANDIDATES = [
        'D:/IDMDownloads/MTool_C68C688D/MTool/mtool-mods',
        'D:\\IDMDownloads\\MTool_C68C688D\\MTool\\mtool-mods'
    ];
    try {
        if (typeof process !== 'undefined' && process.cwd) {
            MOD_DIR_CANDIDATES.push(process.cwd() + '/mtool-mods');
            MOD_DIR_CANDIDATES.push(process.cwd() + '/../mtool-mods');
        }
    } catch (err) { /* 忽略 */ }
    try {
        if (typeof __dirname === 'string') {
            MOD_DIR_CANDIDATES.push(__dirname + '/../mtool-mods');
            MOD_DIR_CANDIDATES.push(__dirname);
        }
    } catch (err) { /* 忽略 */ }

    function resolveModDir() {
        var fs = require('fs');
        var path = require('path');
        for (var i = 0; i < MOD_DIR_CANDIDATES.length; i++) {
            var dir = MOD_DIR_CANDIDATES[i];
            try {
                if (fs.existsSync(path.join(dir, 'MToolValueEditor.js'))) {
                    return { dir: dir, fs: fs, path: path };
                }
            } catch (err) { /* 继续找 */ }
        }
        return null;
    }

    //-------------------------------------------------------------------------
    // 1. 拿到 v8Eval（脚本作用域 / globalThis / wch 三处探测）
    //-------------------------------------------------------------------------
    function findV8Eval() {
        try {
            if (typeof v8Eval === 'function') return v8Eval;
        } catch (err) { /* 忽略 */ }
        try {
            if (ROOT && typeof ROOT.v8Eval === 'function') return ROOT.v8Eval;
        } catch (err) { /* 忽略 */ }
        try {
            if (typeof wch !== 'undefined' && wch && typeof wch.v8Eval === 'function') return wch.v8Eval;
        } catch (err) { /* 忽略 */ }
        return null;
    }

    //-------------------------------------------------------------------------
    // 2. 在游戏里执行代码（自动适配 eval / body 语义）
    //-------------------------------------------------------------------------
    var semantics = null; // 'eval' | 'body'

    function detectSemantics(v8) {
        if (semantics) return semantics;
        try {
            var r = v8('1+1');
            semantics = (r === 2) ? 'eval' : 'body';
        } catch (err) {
            semantics = 'eval';
        }
        return semantics;
    }

    /**
     * 执行一段「语句」代码（IIFE 形态），兼容两种语义。
     * 返回 undefined（不关心返回值）。
     */
    function runInGame(v8, code) {
        detectSemantics(v8);
        try {
            v8(code);
        } catch (err) {
            log('执行失败：' + (err && err.message ? err.message : String(err)));
        }
    }

    /** 在游戏里求一个表达式的值 */
    function evalInGame(v8, expr) {
        var s = detectSemantics(v8);
        try {
            if (s === 'eval') return v8(expr);
            return v8('return (' + expr + ');');
        } catch (err) {
            log('求值失败：' + (err && err.message ? err.message : String(err)));
            return null;
        }
    }

    //-------------------------------------------------------------------------
    // 3. 匹配当前游戏的预设
    //-------------------------------------------------------------------------
    function matchGame(config, title, gameDir) {
        if (!config || !config.games) return null;
        var keys = Object.keys(config.games);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var g = config.games[key];
            if (!g) continue;

            var titles = g.matchTitles || [];
            for (var t = 0; t < titles.length; t++) {
                if (title && title.indexOf(titles[t]) >= 0) {
                    return { key: key, game: g };
                }
            }
            var dirs = g.matchDirs || [];
            for (var d = 0; d < dirs.length; d++) {
                if (gameDir && gameDir.indexOf(dirs[d]) >= 0) {
                    return { key: key, game: g };
                }
            }
        }
        return null;
    }

    //-------------------------------------------------------------------------
    // 4. 主流程
    //-------------------------------------------------------------------------
    function main() {
        var v8 = findV8Eval();
        if (!v8) {
            log('v8Eval 不可用（游戏尚未连接），本次跳过；游戏附加后会自动重跑。');
            return;
        }

        var ctx = resolveModDir();
        if (!ctx) {
            log('找不到 mtool-mods 目录（MToolValueEditor.js 不在候选路径里）。');
            return;
        }

        // 4.1 读插件源码
        var pluginSrc;
        try {
            pluginSrc = ctx.fs.readFileSync(ctx.path.join(ctx.dir, 'MToolValueEditor.js'), 'utf8');
        } catch (err) {
            log('读取插件失败：' + err.message);
            return;
        }

        // 4.2 读配置
        var config = null;
        try {
            var cfgPath = ctx.path.join(ctx.dir, 'MToolValueEditor.config.json');
            if (ctx.fs.existsSync(cfgPath)) {
                config = JSON.parse(ctx.fs.readFileSync(cfgPath, 'utf8'));
            }
        } catch (err) {
            log('读取配置失败：' + err.message);
        }

        // 4.3 识别当前游戏
        var title = evalInGame(v8, '($dataSystem && $dataSystem.gameTitle) || ""') || '';
        var gameDir = evalInGame(v8, '(function(){try{return location.pathname;}catch(e){return "";}})()') || '';

        var matched = matchGame(config, title, gameDir);
        var injectedConfig = null;
        if (matched) {
            injectedConfig = {
                gameId: matched.key,
                title: title,
                entries: matched.game.entries || []
            };
            log('匹配游戏预设：' + matched.key + '（' + title + '），条目 ' + injectedConfig.entries.length + ' 个');
        } else if (config && config.default && Array.isArray(config.default.entries) && config.default.entries.length) {
            injectedConfig = { gameId: 'default', title: title, entries: config.default.entries };
            log('未匹配到预设，使用 default（' + injectedConfig.entries.length + ' 个条目）');
        } else {
            log('未匹配到预设，交由插件自动探测（游戏：' + (title || '未知') + '）');
        }

        // 4.4 注入配置
        if (injectedConfig) {
            runInGame(v8, 'window.__MTOOL_VALUE_EDITOR_CONFIG__ = ' + JSON.stringify(injectedConfig) + ';');
        }

        // 4.5 注入插件（首次加载）
        var loaded = evalInGame(v8, '!!(window.MToolValueEditor && window.MToolValueEditor.__loaded)');
        if (!loaded) {
            runInGame(v8, pluginSrc);
        }

        // 4.6 已加载 → 刷新配置
        var ok = evalInGame(v8, '!!(window.MToolValueEditor && window.MToolValueEditor.__loaded)');
        if (ok) {
            if (injectedConfig) {
                runInGame(v8, 'if (window.MToolValueEditor && window.MToolValueEditor.resetToDefault) { window.MToolValueEditor.resetToDefault(); }');
            }
            var count = evalInGame(v8, 'window.MToolValueEditor.getEntries().length');
            log('插件就绪，当前条目数：' + count + '。按 F9 打开面板。');
        } else {
            log('插件注入失败，请检查 MToolValueEditor.js 是否有语法错误。');
        }
    }

    try {
        main();
    } catch (err) {
        log('loader 异常：' + (err && err.stack ? err.stack : String(err)));
    }
})();
