---
name: xrk-infrastructure
description: 当需要理解或扩展基础设施层（加载器、基类、路径、错误处理）等底层开发时使用。
---

## 文档

- 分层与工具模块：`docs/底层架构设计.md`
- 运行时挂载与裸名约定：`docs/runtime-surface.md`
- 扩展点总览：`docs/框架可扩展性指南.md`

## 基类与加载器

| 扩展点 | 基类 | 加载器 | 扫描目录 |
|--------|------|--------|----------|
| 插件 | `#infrastructure/plugins/plugin-base.js` | `plugins/loader.js` | `core/*/plugin/*.js` |
| HTTP | `#infrastructure/http/http.js` | `http/loader.js` | `core/*/http/*.js` |
| 工作流 | `#infrastructure/ai-workflow/ai-workflow.js` | `ai-workflow/loader.js` | `core/*/workflow/*.js` |
| Tasker | — | `tasker/loader.js` | `core/*/tasker/*.js` |
| 事件 | `#infrastructure/listener/base.js` | `listener/loader.js` | `core/*/events/*.js` |
| 配置 | `#infrastructure/commonconfig/commonconfig.js` | `commonconfig/loader.js` | `core/*/commonconfig/*.js` |
| 渲染器 | `#infrastructure/renderer/Renderer.js` | `renderer/loader.js` | `src/renderers/*` |

浏览器截图实现继承 `src/infrastructure/renderer/browser-renderer-base.js`（Puppeteer/Playwright 共用 lock、Redis WS、截图槽位等）。

## 工具与专题

| 模块 | 路径 | 说明 |
|------|------|------|
| DB 连接 | `#utils/db-connect-utils.js` | Redis/Mongo 共用 retry、URL 脱敏、ARM64 检测 |
| HTTP 业务 API 约定 | `docs/http-api.md` | 路由、`HttpResponse`、`InputValidator` |
| Loader 共享约定 | `docs/infrastructure-shared.md` | 热重载、`FileLoader`、批加载 |
| 基类契约 | `docs/base-classes.md` | plugin/HttpApi/AiWorkflow/ConfigBase/Event |
| 配置种子 | `src/infrastructure/config/config-seed.js` | 端口配置模板复制 |
| 事件键匹配 | `#utils/event-keys.js` | `matchPluginEvent` / `resolveTaskerId`；见 `docs/事件系统标准化文档.md` |
| 运行时挂载 | `#utils/runtime-globals.js` | `setRuntimeGlobal` / `getRuntimeGlobal` |

## `#` 别名

`#utils/*`、`#infrastructure/*`、`#factory/*`、`#config/*`、`#data/*`、`#core/*`、`#renderers/*`、`#modules/*`。业务用裸名 **`msgSegment`**、**`AgentRuntime`**（勿 `global.`）；Core 业务用裸名，框架内可 `import { msgSegment } from '#utils/msg-segment.js'`。

## 约定

- 业务只放 `core/`；改 `src/` 仅限基类/加载器/工具。
- 日志：`RuntimeUtil.makeLog`；HTTP 响应：`HttpResponse`（`#utils/http-utils.js`）；错误：`#utils/error-handler.js` + `normalizeError`。
- `runtimeConfig.aiWorkflow` → `data/server_bots/{port}/ai-workflow.yaml`（非 `server_bots` 根目录）。

## Node 26（改 Core 时）

- 必读 skill **`xrk-node-runtime`**；禁止在 Core 中引入 `node-fetch`、`promisify(exec)`、`instanceof Error` 判错等旧写法。
- 复用底层：`exec-async.js`、`normalize-error.js`、`proxy-utils.js`，勿在 Core 重复封装。
