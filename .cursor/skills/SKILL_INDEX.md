# Skill 索引（本仓库）

## 读者分流（必读）

| 读者 | 放哪 | 写什么 | 不写什么 |
|------|------|--------|----------|
| **Coding Agent**（Cursor / 改 `src`·仓库 `core`） | `.cursor/skills/xrk-*` · 根 `AGENTS.md` | 放码、Loader、配置归属、工厂、Node 26 | 办事语气、办公 skill 细则 |
| **产品 / 办事助手模型** | `agents/skills/standard/**` · 工作区 `skills/` | 工具、场景、**agent-core-dev**（导航写工作区 Core） | 勿**改** `.cursor` / `src`；写 Core 时可 **read** `.cursor/skills/xrk-*` |
| **人读契约** | `docs/*` | 现行行为与配置真源 | 过程日记、迁移叙事 |

全局工程师技能（可选）：维护者本机 Cursor / agents skills，非克隆仓库必装。  
办事助手运营：[docs/agents.md](../../docs/agents.md) · 跑通契约：[docs/agent-context.md](../../docs/agent-context.md)。  
开发入口：仓库根 [`AGENTS.md`](../../AGENTS.md)。

`.claude/` · `.trae/` 是 `sync-skills.ps1` 从 `.cursor/skills` 生成的副本，以 `.cursor` 为准。

## 一眼锁定（任务 → Skill）

| 你在做什么 | 先读 |
|------------|------|
| 写/审 Core 或 `src/` 服务端 | `xrk-node-runtime` → `xrk-coding-style` |
| `core/*/www` / WebView / `sign.json` | `xrk-www-compat` |
| HTTP API / 响应形状 | `xrk-http-api` |
| 配置 YAML / schema / 模板路径 | `xrk-config` |
| 插件 / Loader / 基类 | `xrk-infrastructure` · `xrk-plugins` |
| AI 工作流 / 出站压缩 / 策略安全 | `xrk-ai-workflow` · [`docs/agent-context.md`](../../docs/agent-context.md) |
| MCP 注册 / 远程 / 执行门禁 | `xrk-mcp` · [`docs/mcp-guide.md`](../../docs/mcp-guide.md) |
| LLM 工厂 | `xrk-llm` · `xrk-v3-api` |
| Tasker / 事件入站 / OneBot | `xrk-tasker` · `docs/事件系统标准化文档.md` |
| 子服 / 第三方 apis | `xrk-subserver` |
| 爬虫 / Playwright | `xrk-crawl` |
| 文档导航 | `xrk-docs` |
| 架构总览 | `xrk-project-overview` |
| 外部方案调研 | `xrk-github-research` |

## 设计与前端

- `accessibility-compliance` · `design-system-patterns` · `fronted-design` · `interaction-design`
- `mobile-android-design` / `mobile-ios-design` / `react-native-design`
- `responsive-design` · `ui-ux-pro-max` · `visual-design-foundations` · `web-component-design`

## XRK 核心技能（Coding）

- **`xrk-node-runtime`**：Node 26 API（写 Core/src 前）
- **`xrk-www-compat`**：Core `www/` 浏览器兼容、挂载、HttpResponse 前端解包
- **`xrk-config`**：配置模板归属与 schema 三同步
- **`xrk-http-api`**：HttpApi / HttpResponse 形状
- `xrk-ai-workflow` · `xrk-app-dev` · `xrk-auth` · `xrk-agent-runtime` · `xrk-runtime-util`
- `xrk-docker` · `xrk-docs` · `xrk-github-research`
- `xrk-infrastructure` · `xrk-llm` · `xrk-mcp` · `xrk-plugins`
- `xrk-project-overview` · `xrk-renderer` · `xrk-subserver` · `xrk-system-core`
- `xrk-tasker` · `xrk-v3-api` · `xrk-coding-style` · `xrk-crawl`

## 产品 Agent 技能（勿与上表混用）

路径：`agents/skills/standard/`（`core/agent-*` · `office-*`）。  
索引与用法：[docs/agents.md](../../docs/agents.md)；工具地图：`core/agent-tools`。  
写工作区 Core：`agent-core-dev` → 按表 **只读** 本目录 `xrk-*`（相对工作区 `../../../.cursor/skills/...`）。Coding Agent 仍以本索引为主，产品 Agent **不**改本树。
