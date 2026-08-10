# 鉴权与认证（以代码为准）

> Server 层 **不会**在 `src/agent-runtime.js` 对全部 `/api/*` 做统一拦截；经 **`HttpApi` 注册**且路径以 `/api/` 开头时，由基础设施层**默认**校验系统 API Key（见 `src/infrastructure/http/http.js`）。
> - **system-Core 的 HTTP 路由**：默认需 API Key（可用 `systemAuth: false` 关闭）；
> - **其他 Core**：同样走 `HttpApi` 时规则一致；未使用 `HttpApi` 时需自行调用 `AgentRuntime.checkApiAuthorization(req)` 或 `ensureSystemCoreAuth`。

## 职责划分

| 层级 | 职责 |
|------|------|
| **Server 层**（`src/agent-runtime.js`） | 仅做基础网络层处理：速率限制、Body 解析、静态资源映射等；不再对 `/api/*` 做统一鉴权。鉴权比对委托 `#infrastructure/http/runtime-auth.js`。 |
| **HttpApi 路由**（`src/infrastructure/http/http.js`） | 路径以 `/api/` 开头时默认调用 `ensureSystemCoreAuth` → `AgentRuntime.checkApiAuthorization(req)`。 |
| **system-Core HTTP**（`core/system-Core/http/*.js`） | 仅定义路由与 handler，**无需**在每个 handler 内重复写鉴权代码。 |
| **其他 Core HTTP / Tasker** | 自行决定是否以及如何鉴权；需要接入系统 API Key 时，可在模块内调用 `AgentRuntime.checkApiAuthorization(req)`。 |

---

## Server 层基础处理流程（HTTP）

请求经过 `src/agent-runtime.js` 中的中间件时，认证相关只做静态资源放行：

1. **静态资源**  
   路径为常见静态扩展名（如 `.html`、`.js`、`.ico`、图片、字体等）时直接放行。

除此之外，Server 不会基于 URL 前缀自动放行/拒绝；是否需要 Key、如何校验，完全交给上层模块处理。  
当上层调用 `AgentRuntime.checkApiAuthorization(req)` 时，底层会统一执行（实现：`runtime-auth.js` + `auth.js`）：

- **默认**：凡启用 API Key，**所有客户端**（含本机 127）均须携带有效 Key。
- **可选本机免 Key**：仅当 `server.auth.loopbackExempt === true` 时，才走 `isLoopbackAuthExempt`（须同时：`Host` 为本机、`socket` 为 `127.*`、无公网反代客户端头）。公网 / nginx / frp 部署**必须保持 false**。
- **例外**：当 `ai-workflow.tools.file.runEnabled === true` 时，即便开启了 `loopbackExempt`，本机也强制 Key（可用 `requireLoopbackAuthWhenToolsRun: false` 关闭，不推荐）。
- **可选白名单**：`server.auth.whitelist` 命中时免鉴权。匹配规则：
  - 普通路径：精确匹配或子路径（`/health` 不匹配 `/healthz`）
  - 尾部 `*`：前缀匹配（`/api/public*` → `/api/public/...`）
  - `^...` 或 `regex:...`：正则
  - **禁止** `/`、`/api`（会放行全部或全部 API；编译时丢弃并打警告）
  - `/health`、`/status`、静态 `/xrk` **本就不走** `HttpApi` Key 校验，不必列入白名单
  - 爬虫：`/xrk`、`/core` 默认 `robots.txt` Disallow + `X-Robots-Tag`/`noindex`（见 `server.robots`）；**不能替代**关端口 / 鉴权
- **`enabled === false`**：关闭 API Key 时校验恒通过（含远程；生产勿关）。

默认 `tools.file.runEnabled: false`（见 `config/default_config/ai-workflow.yaml`）。

---

## API Key 校验

- **实现位置**：
  - 薄包装：`src/agent-runtime.js` 的 `checkApiAuthorization(req, options?)`
  - 实际比对：`src/infrastructure/http/runtime-auth.js`
  - loopback / tools 强制策略：`src/infrastructure/http/auth.js`（`isLoopback127Connection`、`shouldForceAuthOnLoopbackWhenToolsRun`）
  - 全局限流 skip：同文件 `isPrivateOrLoopbackAddress`（RFC1918/ULA/回环；**刻意宽于**鉴权的 127-only）
  - HTTP 路由包装：`ensureSystemCoreAuth`（由 `HttpApi.wrapHandler` 自动调用）
- **密钥来源**：`server.auth.apiKey.file`（如 `config/server_config/api_key.json`）中的 `key`；未配置则启动时自动生成并写入该文件。
- **请求中如何携带**（任选其一即可）：
  - 请求头：`X-API-Key: <key>`
  - 请求头：`Api-Key: <key>`
  - 请求头：`Authorization: Bearer <key>` / `Authorization: Token <key>` / `Authorization: ApiKey <key>`
  - 查询参数：`?api_key=<key>` 或 `?apiKey=<key>`（WebSocket 升级同此；不接受 body / `token` / `key` 等易撞字段）
- **校验方式**：使用 `crypto.timingSafeEqual` 做常量时间比较，防止时序攻击。
- **空密钥文件**：`api_key.json` 存在但 `key` 为空时视为无效，启动时重新生成。
- **`enabled === false`**：关闭 API Key 时校验恒为通过（含远程）。

---

## WebSocket 鉴权

所有通过 Tasker 暴露的 WebSocket 路径（`AgentRuntime.wsf`）都会先经过 `runtime-ws.js`（由 `AgentRuntime.wsConnect` 委托）统一鉴权：
 
- **127 回环连接**：一般直接放行（仅 `127.*` / `::ffff:127.*`）；`runEnabled` 开启时与 HTTP 相同，强制 API Key；
- **远程连接**：若 `server.auth.apiKey.enabled !== false`，则默认必须通过 `AgentRuntime.apiKey` 校验，否则返回 `401 Unauthorized` 并拒绝升级；
- **Tasker 级免鉴权**：若某个 WS 路径在 `AgentRuntime.wsf[path]` 中包含形如 `{ handler, skipAuth: true }` 的条目，则视为该路径整体“跳过系统级 API Key 鉴权”。

客户端可以通过以下任一方式携带系统 API Key（与 HTTP 一致）：

- 头部：`X-API-Key: <key>` / `Api-Key: <key>`
- 头部：`Authorization: Bearer <key>` / `Authorization: Token <key>` / `Authorization: ApiKey <key>`
- 查询：`?api_key=<key>` 或 `?apiKey=<key>`（如 `wss://host/device?api_key=<key>`）

各 Tasker 若还需要额外的业务级鉴权（例如设备 ID 白名单），可以在各自的 WS handler 内再做一层校验；对于显式声明 `skipAuth: true` 的路径，推荐在 Tasker 内自行实现细粒度的业务鉴权逻辑。

---

## 相关文件

- HTTP 基础与委托入口：`src/agent-runtime.js`  
  - `_authMiddleware(req, res, next)`：HTTP 基础放行（静态资源）  
  - `checkApiAuthorization(req)` → `runtime-auth.js`  
  - `wsConnect` → `runtime-ws.js`
- 鉴权实现：`src/infrastructure/http/runtime-auth.js`、`auth.js`、`http.js`（`route.systemAuth` / `_withDefaultSystemAuth`）
- system-Core 路由定义：`core/system-Core/http/*.js`

---

## 常见问题

**Q：现在鉴权到底写在哪一层？**  
A：`src/agent-runtime.js` 只做静态资源放行；`/api/*` 由 `HttpApi` 在 `wrapHandler` 中默认鉴权。业务 handler 内一般不必再写鉴权。

**Q：如何使用系统 API Key 保护自定义 HTTP 接口？**  
A：在 `core/<your-core>/http/*.js` 导出 `HttpApi` 路由对象即可；路径以 `/api/` 开头会自动鉴权。非 `/api/` 路径或不用 `HttpApi` 时，在 handler 内调用 `ensureSystemCoreAuth(req, res, bot, 'context')`（`src/infrastructure/http/auth.js`）。

**Q：本地调试可以不带 Key 吗？**  
A：**默认不可以。** 凡启用 API Key，本机也须带 Key。仅当显式配置 `server.auth.loopbackExempt: true` 且请求满足 `isLoopbackAuthExempt`（本机 Host + socket 127 + 无公网反代头）时才免 Key。公网 / nginx / frp **勿开** loopbackExempt。

**Q：控制台如何判断「鉴权是否生效」？**  
A：公开接口 `GET /api/system/auth-mode`（`systemAuth: false`）返回 `requiresKey`；控制台 `refreshAuthMode` 读此接口。**不要**用无 Key 打受保护接口再看 401。

**Q：新增 HTTP 路由时鉴权要注意什么？**  
A：经 `HttpApi` 注册且路径以 `/api/` 开头时**默认**鉴权；公开接口写 `systemAuth: false`。实现见 `src/infrastructure/http/http.js` 与 `src/infrastructure/http/auth.js`。

**Q：能不能用 Strix 给 AGT 做渗透？**  
A：可以，但只作**外部**本机/CI 工具，扫自有仓或自有环境；**不要**做成插件或聊天触发。见 [security-strix.md](security-strix.md)。
