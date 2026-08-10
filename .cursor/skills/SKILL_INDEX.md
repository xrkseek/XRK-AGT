# Skill 索引（本仓库）

Coding Agent / 克隆本仓写 Core：根 [`AGENTS.md`](../../AGENTS.md)。办事助手运营：[docs/agents.md](../../docs/agents.md)。

| 读者 | 放哪 | 写什么 |
|------|------|--------|
| **Coding Agent** | `.cursor/skills/xrk-*` · 根 `AGENTS.md` | 放码、Loader、配置、工厂、Node 26 |
| **产品 / 办事助手模型** | `agents/skills/standard/**` | 工具与场景；写工作区 Core 时 **只读** `xrk-*`，勿改 `.cursor` / `src` |
| **人读契约** | `docs/*` | 现行行为 |

`.claude/` · `.trae/` 由 `sync-skills.ps1` 从 `.cursor/skills` 生成，以 `.cursor` 为准。

## 一眼锁定（任务 → Skill）

| 你在做什么 | 先读 |
|------------|------|
| 写/审 Core 或 `src/` 服务端 | `xrk-node-runtime` → `xrk-coding-style` |
| `core/*/www` / WebView / `sign.json` | `xrk-www-compat` |
| HTTP API / 响应形状 | `xrk-http-api` |
| 配置 YAML / schema / 模板路径 | `xrk-config` |
| 插件 / Loader / 基类 | `xrk-infrastructure` · `xrk-plugins` |
| AI 工作流 / 出站 / 策略安全 | `xrk-ai-workflow` · [`docs/agent-context.md`](../../docs/agent-context.md) |
| MCP | `xrk-mcp` · [`docs/mcp-guide.md`](../../docs/mcp-guide.md) |
| LLM 工厂 | `xrk-llm` · `xrk-v3-api` |
| Tasker / 事件 / OneBot | `xrk-tasker` · `docs/事件系统标准化文档.md` |
| 子服 / 第三方 apis | `xrk-subserver` |
| 爬虫 / Playwright | `xrk-crawl` |
| 文档导航 | `xrk-docs` |
| 架构总览 | `xrk-project-overview` |
| 外部方案调研 | `xrk-github-research` |

## XRK 核心技能（Coding）

- **`xrk-node-runtime`** · **`xrk-www-compat`** · **`xrk-config`** · **`xrk-http-api`**
- `xrk-ai-workflow` · `xrk-app-dev` · `xrk-auth` · `xrk-agent-runtime` · `xrk-runtime-util`
- `xrk-docker` · `xrk-docs` · `xrk-github-research`
- `xrk-infrastructure` · `xrk-llm` · `xrk-mcp` · `xrk-plugins`
- `xrk-project-overview` · `xrk-renderer` · `xrk-subserver` · `xrk-system-core`
- `xrk-tasker` · `xrk-v3-api` · `xrk-coding-style` · `xrk-crawl`

产品 Agent 技能在 `agents/skills/standard/`（与上表分用）。
