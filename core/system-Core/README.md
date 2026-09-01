# system-Core — 参考 Core（给新开发者）

主仓唯一跟踪的业务 Core。目标是**薄接线 + 完整示范**：展示如何挂 Loader 约定目录，而把平台能力放在 `src/`。

## 目录职责

| 目录 | 职责 | 新 Core 是否复制 |
|------|------|------------------|
| `plugin/` | PluginBase 示范与系统插件 | 复制结构，按需写规则 |
| `http/` | HttpApi + `HttpResponse` 示范 | 复制结构 |
| `workflow/` | AiWorkflow 子类；只**接线**工具 | 复制；勿内嵌 SSRF/搜索驱动 |
| `events/` | ListenerBase 薄封装 | 复制 |
| `tasker/` | 协议适配（OneBot/stdin 等） | 按需 |
| `commonconfig/` | Schema 示范（与 `config/default_config` 对齐） | 独立 Core 用自己的 schema + `default/` |
| `default/` | Core 内默认 yaml（如 `ai_config`） | 独立 Core 必备 |
| `www/<app>/` | 静态前端（须子目录） | 按需 |
| `lib/` | **仅产品门面**（见下） | 勿塞平台工具 |

## `lib/` 允许保留

- `ai-assistant-runtime.js` / `ai-workspace-*.js` — 控制台与助手编排
- `content-safety/` — system 产品能力

Agent loop 不在 Core：固定 `@xrkseek/harness` 模块嵌入（见主仓 `docs/harness-module-loop.md`）。

## 禁止写进 Core（放 `src/`）

| 能力 | 落点 |
|------|------|
| SSRF / web_fetch / web_search / Playwright session | `#infrastructure/crawl` |
| 带超时重试的外联 fetch | `#utils/fetch-with-retry.js` |
| Disposables | `#utils/disposables.js` |
| v3 工具面名单 | 请求体 `workflow.workflows`（含 `remote-mcp.*`，无服务端默认） |
| AiWorkflow 基类 / Loader / MemoryManager | `#infrastructure/ai-workflow/*` |

示范接线：

```javascript
import { runWebFetch, buildWebFetchRuntime } from '#infrastructure/crawl/index.js';
```

见 `workflow/web.js`、`workflow/browser.js`。

## 新 Core 最小清单

1. `commonconfig/` +（独立产品）`default/<name>.yaml` + `data/<产品>/`  
2. 至少一个 `workflow/*.js` 或 `plugin/*.js`  
3. 需要 HTTP 时：`http/*.js` 用 `HttpResponse`  
4. **不要**新建 `lib/crawl` 或复制 `src/infrastructure/crawl`  
5. 有 `package.json` 的 Core：**禁止** `#` 别名，改用相对路径引用根 `src/`

配置模板归属见根规则 `xrk-project.mdc`：独立产品 Core **不得**往 `config/default_config/` 塞业务 yaml。

## 已知厚文件（待拆，本参考不掩盖）

| 文件 | 说明 |
|------|------|
| `workflow/chat.js` | 对话主路径过长 |
| `tasker/OneBotv11.js` | 协议适配过长 |
| `http/device.js` | 设备 API 过长 |
| `www/xrk/app.js` | 控制台入口过长 |

新 Core 请按「一文件一职责」拆分，勿照抄神文件体积。

## 相关文档

- [docs/system-core.md](../../docs/system-core.md) — 模块与工作流清单  
- [docs/底层架构设计.md](../../docs/底层架构设计.md) — Runtime vs Core  
- skill `xrk-crawl` — 抓取/浏览器平台能力  
- skill `xrk-system-core` — 本 Core 速查  
