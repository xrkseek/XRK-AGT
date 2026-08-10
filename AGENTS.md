# AGENTS.md — XRK-AGT（Coding Agent）

面向在本仓库写代码、改 Core、排查框架的 AI / 开发者（含克隆本仓的用户）。

## 哪份 AGENTS.md？

| 文件 | 读者 | 写什么 |
|------|------|--------|
| **本文件**（仓库根） | **Coding Agent** | 放码、配置归属、本仓 skill 路由；**仓库契约**，勿写个人工作流 |
| `agents/workspace/AGENTS.md` → `data/ai-workspace/{id}/` | **产品 / 办事助手模型** | 注入 prompt 的办事规则 |
| `core/<core>/AGENTS.md`（若有） | **产品 Agent** | 该产品工作区与工具边界；**不写** LLM 工厂 / commonconfig / 底层路径 |
| [`docs/agents.md`](docs/agents.md) | 人（运维 / 维护者） | 办事助手怎么配、怎么用 |

人读契约与导航：[`docs/README.md`](docs/README.md) · [`docs/agent-context.md`](docs/agent-context.md)。

## 项目定位

通用后端 Runtime（`src/`）+ 业务 Core（`core/`）。业务放在 `core/`。

- **首读**：[`docs/runtime-surface.md`](docs/runtime-surface.md) · [`docs/coding-style.md`](docs/coding-style.md) · [`docs/base-classes.md`](docs/base-classes.md)
- **文档导航**：skill `xrk-docs` · [`docs/README.md`](docs/README.md)
- **栈**：Node ≥ 26 · 包管理仅 **pnpm** · 启动 `node app` → `start.js` → `src/agent-runtime.js`

## 本仓规则（`.cursor/rules/`）

| 规则 | 作用 |
|------|------|
| `xrk-project.mdc` | 架构、放码、配置归属；娱乐插件白名单策略 |
| `xrk-dev-requirements.mdc` | 裸名全局对象、HttpResponse、Core www、Node 26 |
| `xrk-agent-behavior.mdc` | 本仓边界与 skill 入口 |
| `xrk-third-party-plugins.mdc` | 主仓 gitignore / 子服插件约定 |

写码优先复用 Loader / ConfigBase / HttpResponse / `#utils/*`。文档 / skill 与实现冲突时以**代码**为准。

## 一眼锁定（任务 → Skill）

改 `core/` / `src/` 前：Grep 调用方 → **Read** 对应 `SKILL.md` → 再动手。索引：[`.cursor/skills/SKILL_INDEX.md`](.cursor/skills/SKILL_INDEX.md)。

| 读者 | 技能树 |
|------|--------|
| **Coding Agent**（本对话改代码） | `.cursor/skills/xrk-*` |
| **产品 / 办事助手模型** | `agents/skills/standard/**`；写工作区 Core 时按 **agent-core-dev** **只读** `.cursor/skills/xrk-*` |
| **人读契约** | `docs/*`（勿把 coding skill 写进产品 skill） |

| 你在做什么 | 先读 |
|------------|------|
| 写/审 Core 或 `src/` 服务端代码 | `xrk-node-runtime` → `xrk-coding-style` |
| `core/*/www` 静态页 / WebView / 挂载 / `sign.json` | `xrk-www-compat` |
| HTTP API / handler / 响应形状 | `xrk-http-api`；前端解包见 `xrk-www-compat` |
| 新增/改 YAML 字段、schema、模板路径 | `xrk-config` |
| 插件 / Loader / 基类扩展点 | `xrk-infrastructure` · `xrk-plugins` |
| AI 工作流 / 出站 / 策略安全 / MCP | `xrk-ai-workflow` · `xrk-mcp` · [`docs/agent-context.md`](docs/agent-context.md) |
| 办事助手种子 / 工作区注入 | [`docs/agents.md`](docs/agents.md) · [`docs/agent-context.md`](docs/agent-context.md) · `src/utils/agent-workspace.js` |
| LLM 工厂 / 代理 fetch | `xrk-llm` · `xrk-v3-api` |
| Tasker / 事件入站 / OneBot | `xrk-tasker` · [`docs/事件系统标准化文档.md`](docs/事件系统标准化文档.md) |
| 子服 / 第三方 `apis/` | `xrk-subserver` · `xrk-third-party-plugins` |
| 爬虫 / Playwright | `xrk-crawl` |
| 架构总览 / 放哪 | `xrk-project-overview` · `xrk-project.mdc` |
| 外部方案调研再接入 | `xrk-github-research`（说明如何接 Loader / ConfigBase） |

## 放码与配置

| 类型 | 路径 |
|------|------|
| 业务 | `core/<core>/{plugin,http,workflow,tasker,events,commonconfig,www/<app>}/` |
| Runtime / 基类 / 工厂 | `src/infrastructure/` · `src/utils/` · `src/factory/` |
| system / 工厂配置模板 | `config/default_config/`（仅 AGT / 工厂 / system-Core） |
| 独立产品模板 / schema / 运行时 | `core/<core>/default/` · `commonconfig/` · `data/<产品>/` |
| 办事助手种子 | `agents/` → 运行时 `data/ai-workspace/{id}/` |

- Core 业务在 `core/`；扩 Runtime 能力改 `src/`，经文档 / commonconfig 暴露。
- 无 `package.json` 的 core：可用 `#infrastructure/*`、`#utils/*`。有 `package.json` 的 core：相对路径引用根 `src/`。
- HTTP：`HttpResponse`（`#utils/http-utils.js`）。全局：`AgentRuntime` / `msgSegment` 裸名。
- `www/<应用名>/` 为子目录；保留根名：`api` · `core` · `media` · `uploads` · `File` · `shared`。
- 娱乐插件：配置写插件顶部，本地忽略运行；不进 system-Core 白名单、默认不提交。

## 写法要点

| 场景 | 做法 |
|------|------|
| 产品配置 | `core/<core>/default/` + `commonconfig/` + `data/<产品>/` |
| `HttpResponse.success` 普通对象 | 字段拍平到顶层；前端用 `unwrapSuccess` 或读顶层字段 |
| Core www 超时 / ID / 克隆 | 内联与 `/xrk` 同源语义（见 `xrk-www-compat`） |
| AI 工作流目录与配置名 | `workflow` / `ai-workflow` |
| 改办事助手已有文稿 | `search_replace`（见 `docs/agents.md`） |
| 第三方 `apis/` | 框架白名单 + 本地 clone（`xrk-third-party-plugins`） |
| 启动早期读配置 | ConfigBase / 默认模板；等 `CommonConfigRegistry.load()` 后再用 `runtimeConfig` |
| 实例缓存 / 易变状态 | 类字段声明处或 `init()` 初始化 |

## 文档约定

- 只写现行契约；「在哪改」给到文件 + 函数/字段；与代码冲突以代码为准。
- 产品 Core：`README.md` 写集成；`AGENTS.md` / `skills/`（若有）写产品 Agent 工作区与工具。
- 独立 git 产品 Core：精工 / Cursor 约定写在该 Core 的 `.cursor/rules/`；主仓不 alwaysApply 产品细则（见 `xrk-project`）。
- 索引：[docs/README.md](docs/README.md) · 办事助手：[docs/agents.md](docs/agents.md)

## GitHub MCP（可选）

模板：`.cursor/mcp.json.example`。本地 PAT 放在本机 Cursor MCP 配置，勿提交密钥。
