# MTool Value Editor

游戏内数值编辑器，面向 RPG Maker MZ 游戏。通过 MTool 的 v8 桥接注入一个可随时呼出的面板（F9），在游戏运行中查看、修改、锁定任意数值。

最初为《不洁圣女 / UnholyMaiden》制作，现已抽象为可跨游戏复用的通用工具。

---

## 目录结构

| 文件 | 作用 |
|---|---|
| `MToolValueEditor.js` | **核心插件**（RPG Maker MZ 插件）。注入游戏后提供 F9 面板、锁定、属性覆盖等全部功能。 |
| `MToolValueEditor.config.json` | **游戏的数值映射配置**。定义面板里显示哪些条目、对应哪个变量/属性。 |
| `mtool-value-editor-loader.js` | **MTool 脚本 mod**。MTool 启动时自动加载，负责把插件注入当前游戏。 |
| `install-value-editor.ps1` | **独立安装器**。把插件以正规 MZ 插件方式装进游戏目录，无需 MTool 常驻。 |

---

## 安装与使用

### 方式 A：通过 MTool 脚本 mod（推荐，适合临时使用）

1. 把 `MToolValueEditor.js`、`MToolValueEditor.config.json` 放在 `mtool-mods` 目录。
2. 把 `mtool-value-editor-loader.js` 注册进 MTool 的脚本 mod 列表（`CollData.json`），并重启 MTool。
3. 进入游戏后按 **F9** 呼出面板。

> loader 会在游戏启动后把插件注入当前进程，并对已运行的游戏调用 `reload()` + 自动打开面板（可配置）。

### 方式 B：作为独立插件安装（适合长期使用）

```powershell
powershell -ExecutionPolicy Bypass -File .\install-value-editor.ps1 -GameDir "E:\path\to\YourGame"
```

安装器会：

1. 复制 `MToolValueEditor.js` 与 `.config.json` 到 `<GameDir>\js\plugins\`
2. 备份原 `plugins.js`
3. 在 `plugins.js` 末尾注册插件（幂等，重复执行不会重复注册）
4. 校验失败自动回滚

安装后**重启游戏**即可生效，无需 MTool 常驻。

---

## 面板操作

| 按键 | 作用 |
|---|---|
| **F9** | 打开 / 关闭面板（战斗中也可用，战斗会暂停） |
| **↑ ↓** | 选择条目 |
| **← →** | 调整数值（按住 **Shift** 步进 ×10） |
| **Enter** | 精确输入数值；对开关/按钮类条目则是切换或执行 |
| **A** | 添加一个自定义变量条目 |
| **D** | 删除当前条目 |
| **L** | 锁定 / 解锁当前条目（每 20 帧强制回写一次） |
| **R** | **恢复**当前派生属性的覆盖值 |
| **Shift + R** | **恢复全部**派生属性覆盖 |
| **Esc** | 关闭面板 |

### 条目视觉标记

| 标记 | 含义 |
|---|---|
| 名称前 **◇** | 覆盖层实现的项（param/xparam/sparam），当前为原始计算值 |
| 名称前 **◆**（青色） | 覆盖层实现的项，**已被修改**（按 R 可恢复） |
| 数值 **黄色** | 普通数值 |
| 数值 **绿色** | 已锁定 |
| 数值 **青色** | 已覆盖 |

---

## 支持的条目类型

配置里每个条目通过 `id` 或 `special` 指定数据源：

| 类型 | 配置写法 | 数据源 |
|---|---|---|
| 普通变量 | `{ "id": 69 }` | `$gameVariables.value(69)` |
| 队伍金钱 | `{ "special": "gold" }` | `$gameParty.gold()` |
| 角色 HP | `{ "special": "actorHp" }` | 队长 `actor.hp` |
| 角色 MP | `{ "special": "actorMp" }` | 队长 `actor.mp` |
| 角色 SP(TP) | `{ "special": "actorTp" }` | 队长 `actor.tp`（上限 100） |
| 物品数量 | `{ "special": "item", "itemId": 21 }` | `$gameParty.numItems()` |
| 基础属性 | `{ "special": "param", "paramId": 2 }` | `actor.param(2)`（0:mhp 1:mmp 2:atk 3:def 4:mat 5:mdf 6:agi 7:luk） |
| X 参数 | `{ "special": "xparam", "paramId": 1, "scale": 100 }` | `actor.xparam(1)`（1:eva 2:cri …） |
| S 参数 | `{ "special": "sparam", "paramId": 6, "scale": 100 }` | `actor.sparam(6)`（6:pdr 7:mdr …） |
| 必死一击 | `{ "special": "oneShot" }` | 下一次敌人攻击必中且归零 |
| 游戏开关 | `{ "special": "gameSwitch", "switchId": 262 }` | `$gameSwitches.value()` |
| 公共事件 | `{ "special": "commonEvent", "eventId": 130 }` | 强制运行公共事件（**暂禁用**，见下方限制） |

### 条目通用字段

```jsonc
{
  "id": 69,                 // 或 special
  "label": "等级 Lv",       // 显示名
  "step": 1,                // ←→ 调整步进
  "min": 1,                 // 下限
  "max": 9999,              // 上限
  "rankId": 461,            // 可选：等级字母变量（联动显示 F~S）
  "thresholds": [4,10,15,25,35,50]  // 可选：等级阈值表
}
```

---

## 配置加载优先级

```
window.__MTOOL_VALUE_EDITOR_CONFIG__   ← 运行时注入（最高）
        ↓
配置文件（MToolValueEditor.config.json）
        ↓
内置预设（插件内 BUILTIN_PRESETS，按游戏标题匹配）
        ↓
自动探测（扫描变量名关键词，生成默认条目）
```

配置文件支持两种结构：

```jsonc
// 结构一：只给一个游戏
{ "entries": [ ... ] }

// 结构二：按游戏分
{ "games": { "unholy-maiden": [ ... ], "another-game": [ ... ] } }
```

---

## 针对《不洁圣女》的已知数值映射

| 内容 | 变量 / 来源 |
|---|---|
| 等级 Lv | 变量 #69（经验 #68，上限 #271） |
| HP / MP / SP | 队长 `hp/mp/tp`（SP 即 TP） |
| 六维（体力/筋力/技術/知性/話術/美貌） | #41–#46（等级字母 #461–#466） |
| 紧身衣破损％ | #561（护甲 #98 名称引用 `\v[561]`） |
| 药（界面显示值） | #13 |
| 回复药（背包实际数量） | 物品 #21 |
| 开锁成功率 | #75（由公共事件 #25 计算） |
| 开锁加成 A / B | #74 / #317 |
| 队伍金钱 | `$gameParty.gold()` |

---

## 回滚 / 卸载

**方式 B（插件安装）**：

1. 删除 `<GameDir>\js\plugins\MToolValueEditor.js` 与 `.config.json`
2. 用安装器生成的 `plugins.js.bak-before-mte-*` 覆盖 `plugins.js`
3. 或者手动从 `plugins.js` 中删除 `MToolValueEditor` 那一项

**方式 A（脚本 mod）**：从 MTool 脚本 mod 列表移除 loader 并重启 MTool。

> 存档不受影响：本工具只修改运行时内存与 `localStorage` 中的锁定配置。

---

## 已知限制

- **仅支持 RPG Maker MZ**（依赖 `ColorManager.textColor`、`Game_BattlerBase.param` 等 MZ 1.9 API；MV 不兼容）。
- **战斗中可以打开**，战斗会暂停、关闭后恢复。
- **派生属性（param/xparam/sparam）是覆盖值**：改过之后不再随装备变化，需按 **R** 恢复。
- **公共事件强制演出** 功能暂禁用（MZ 战斗中 `reserveCommonEvent` 不自动执行，手动驱动 Interpreter 实测无效）。
- **修改 `plugins.js` 需重启游戏**；运行时热重载插件不会生效（除非像本工具这样手动重注入）。
- 任何 hook 都保证原样转发参数，异常一律 `try/catch` 吞掉，**不影响游戏主循环**。

---

## 开发备注

- 插件通过 `window.MToolValueEditor` 暴露 API：

  ```js
  MToolValueEditor.open()                    // 打开面板
  MToolValueEditor.close()                   // 关闭面板
  MToolValueEditor.getEntries()              // 全部条目
  MToolValueEditor.getEntry('param:2')       // 按 id / special / param:ID 查找
  MToolValueEditor.setValue('param:2', 3000) // 修改
  MToolValueEditor.hasOverride('param:2')    // 是否被覆盖
  MToolValueEditor.clearOverride('param:2')  // 恢复单项
  MToolValueEditor.clearAllOverrides()       // 恢复全部
  MToolValueEditor.exportConfig()            // 导出当前配置
  MToolValueEditor.importConfig(json)        // 导入配置
  MToolValueEditor.reload()                  // 重新读取配置
  ```

- 修改插件后可用 MTool 热重载：

  ```js
  delete window.MToolValueEditor;
  var fs = require('fs');
  (0, eval)(fs.readFileSync('<GameDir>/js/plugins/MToolValueEditor.js', 'utf8'));
  window.MToolValueEditor.reload();
  window.MToolValueEditor.open();
  ```

- 热重载不会叠面板层：`Scene_MtoolPanel` 带 `__mtePanel` 标记，`open()` 幂等，`prunePanelStack()` 会清掉历史遗留层。
