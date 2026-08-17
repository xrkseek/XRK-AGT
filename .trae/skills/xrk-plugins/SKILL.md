---
name: xrk-plugins
description: 当你需要理解/开发插件（plugin 基类）、插件加载与规则匹配、上下文和冷却机制时使用。
---

## 文档与代码

- `docs/plugin-base.md`、`docs/runtime-surface.md`、`docs/plugins-loader.md`、`docs/事件系统标准化文档.md`
- `src/infrastructure/plugins/plugin-base.js`、`plugins/loader.js`、`#utils/event-keys.js`
- 示例：`core/system-Core/plugin/*.js`

## 约定

- 路径：`core/*/plugin/*.js`（含办事工作区 `data/ai-workspace/*/core/*/plugin`）；入口 `PluginLoader.deal(e)`。
- 基类：`import PluginBase from '#infrastructure/plugins/plugin-base.js'`；`extends PluginBase`。
- 裸名 **`msgSegment`**、**`AgentRuntime`**；勿 `global.msgSegment` / `global.AgentRuntime`。
- constructor 不建缓存/Map；`rule[].fnc(e)` 用 `e.msg`。
- **`event` 匹配**（`matchPluginEvent`）：
  - 跨 Tasker：`message` / `message.group` / `notice.*.poke`
  - 定 Tasker：`onebot.message` / `device.*`（首段非通用 post_type 时必须与 `e.tasker` 一致，否则不命中）
  - 可选 `tasker` / `taskers` 白名单（别名经 `coerceTaskerId`，如 `api`→`stdin`）
- **戳一戳等 notice**：`event: 'notice.*.poke'`；逻辑放 `accept()`。勿为业务去改 Tasker。
- 调 AI：`this.getWorkflow('chat'|...)` + `stream.process(e, e.msg, options)`。
- 错误：`Error.isError` / `normalizeError`（skill **`xrk-node-runtime`**）。
- 产品 / 办事助手写工作区 Core：导航 skill **`agent-core-dev`**（配方优先，只读本 skill）。
