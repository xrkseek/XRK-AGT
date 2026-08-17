---
name: xrk-auth
description: 当你需要解释/排查 HTTP 或 WebSocket 的 401、127 回环例外、API Key 机制时使用；确保业务层不重复鉴权。
---

## 文档与代码

- `docs/AUTH.md`
- 门面：`src/agent-runtime.js`（`_authMiddleware`、`checkApiAuthorization`、`wsConnect`）
- 实现：`src/infrastructure/http/runtime-auth.js`、`runtime-ws.js`、`auth.js`

## 原则

- `/api/` 由 `HttpApi` + `AgentRuntime.checkApiAuthorization`；公开路由 `systemAuth: false`。
- 默认所有客户端须 API Key；`server.auth.loopbackExempt===true` 时才允许「本机 Host+127」免 Key（公网/反代勿开）。`runEnabled=true` 时即便 exempt 也强制 Key。
- 控制台鉴权模式：公开 `GET /api/system/auth-mode` → `requiresKey`；**禁止**用无 Key 打受保护接口靠 401 探测。
- WS：`wsConnect` → `runtime-ws`；`AgentRuntime.wsf[path]` 可为 `{ handler, skipAuth: true }` 跳过系统 Key。

## API Key 携带

Header：`X-API-Key`、`Api-Key`、`Authorization: Bearer|Token|ApiKey <key>`；查询仅 `api_key` / `apiKey`。不接受 body 与 `token`/`key` 等易撞字段。

## Node 26

- 扩展时判错用 `Error.isError`，勿 `instanceof Error`（skill **`xrk-node-runtime`**）。
- 业务 Core **不重复**实现鉴权；HTTP 超时仍用 `AbortSignal.timeout`。
