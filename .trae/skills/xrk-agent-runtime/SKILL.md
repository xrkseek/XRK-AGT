---
name: xrk-agent-runtime
description: 当你需要理解 XRK-AGT 的运行时核心（AgentRuntime 主类）、事件总线、HTTP/WS 启动流程与全局对象时使用。
---

## 文档与代码

- 文档：`docs/agent-runtime.md`、`docs/runtime-surface.md`、`docs/server.md`
- 代码：`src/agent-runtime.js`、`src/utils/runtime-globals.js`

## 关键职责

- 启动 HTTP/HTTPS/WebSocket 服务器，以及基础中间件（压缩、安全头、CORS、日志、基础认证等）。
- 初始化加载器：TaskerLoader / HttpApiLoader / AiWorkflowLoader / PluginLoader。
- 维护运行时 `AgentRuntime`（Proxy）：`AgentRuntime[self_id]`、`AgentRuntime.tasker` / `AgentRuntime.wsf` / `AgentRuntime.uin` / `AgentRuntime.em()` / `AgentRuntime.makeLog()`。

## 全局写法（业务 `core/`）

- **裸名** `AgentRuntime`，勿 `import AgentRuntime`、`new AgentRuntime()`、**勿** `global.AgentRuntime`。
- HTTP handler：`req.agentRuntime` 或第三参 `AgentRuntime`。
- 挂载仅在 `src/`：`setRuntimeGlobal('AgentRuntime', runtime)`（`start.js`、`tasker/loader.js`）。
- 详见 `docs/runtime-surface.md`、`.cursor/rules/xrk-dev-requirements.mdc`。

## 其它

- 事件总线：`em('{tasker}.{post_type}', data)`；级联只剥点号父级（`onebot.message`→`onebot`）。插件过滤见 `#utils/event-keys.js`，文档 `docs/事件系统标准化文档.md` · skill **`xrk-tasker`**。
- `callRoute` / 公网探测：全局 `fetch` + `AbortSignal.timeout`（见 `src/agent-runtime.js`）。
- Node 26 约定：skill **`xrk-node-runtime`**。
