---
name: xrk-tasker
description: 当你需要理解或编写新的 Tasker（OneBotv11/GSUIDCORE/QBQBot/stdin/device 等协议入站层）时使用。
---

## 文档与代码

`docs/tasker-loader.md`、`docs/tasker-base-spec.md`、`docs/事件系统标准化文档.md`、`core/system-Core/tasker/*.js`、`core/system-Core/events/*.js`

## 职责

协议入站 → 统一事件 `e` → `core/*/events/` Listener → `PluginLoader.deal(e)`。

## 现行契约（必遵）

1. **派发名**：`AgentRuntime.em('{短名}.{post_type}', e)`（或 `TaskerBase.emitEvent(短名, e, bot)`）。  
   例：`onebot.message` / `device.message` / `stdin.message` / `opqbot.message` / `gsuidcore.message`。  
   **禁止**对业务入站裸 `em('message')` / `em('message.group')`（无对应 Listener 则插件链不跑）。
2. **`e.tasker`**：字符串短名（`onebot` / `device` / `stdin` / …）。禁止把 Tasker 实例挂到事件上（`bot.tasker = this` 仅挂 bot）。
3. **Listener**：`core/<core>/events/<短名>.js` 继承 `ListenerBase`，`bot.on('{短名}.message|notice|request', …)` → `markTasker` → `plugins.deal`。
4. **Enhancer（可选）**：`event: '{短名}.*'` + `tasker: '{短名}'`，只增强本通道。
5. **插件匹配**：`#utils/event-keys.js` → `matchPluginEvent`；定 Tasker 订阅（如 `onebot.message`）不命中其它 tasker。

别名：`api`→`stdin`，`qq`→`opqbot`（见 `coerceTaskerId`）。

## Node 26

- 消息二进制：`Buffer#toBase64()`，勿 `toString('base64')`。
- 错误与网络：skill **`xrk-node-runtime`**。
