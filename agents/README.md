# agents/ — 办事助手种子（XRK 标准布局）

第一次启用工作区时，模板从 `agents/workspace/` 复制到 `data/ai-workspace/{id}/`；技能从 `.xrk/skills/` 同步。之后以运行时那份为准（**缺啥补啥，不覆盖已有**）。

| 文档 | 路径 |
|------|------|
| 用户 / 运维 / 维护者 | [docs/agents.md](../docs/agents.md) |
| Agent 跑通契约 | [docs/agent-context.md](../docs/agent-context.md) |
| 模型注入规则（模板） | [workspace/AGENTS.md](workspace/AGENTS.md) |
| 框架 / Core 开发（Coding Agent） | 仓库根 [AGENTS.md](../AGENTS.md) · `.cursor/skills/xrk-*` |

**技能分流**：`.xrk/skills/` 只给**办事助手模型**（`tools.read` 细则）。Cursor 改框架请看 `.cursor/skills/`，不要把 `xrk-*` 写进本树。

## 目录

| 路径 | 用途 |
|------|------|
| `workspace/` | 工作区模板：规则、偏好、本机备注、记忆、`rules/`、`core/`（业务插件沙箱） |
| `rules/` | 产品共享护栏（XRK-AGT **运行时**直接注入；`.mdc` 带 `xrk-inject: false`，不进 XRKH standing） |
| `recipes/` | 斜杠配方（`/recipes` · `/recipe <id>`） |
| `microagents/` | triggers 命中时整段注入的短手册 |
| `subagents.yaml` | 主助手与专项角色清单 |
| `../.xrk/skills/` | 产品 Agent 技能：办公、检索、**agent-core-dev**、agent-skillhub 等 |

## 改哪里

| 目的 | 路径 |
|------|------|
| 日常定制（语气、偏好、本机路径） | `data/ai-workspace/{id}/` |
| 本工作区护栏（用户加法） | 工作区 `rules/`（仅同名时覆盖 `agents/rules/`） |
| 更新默认模板 | `agents/workspace/`（工作区已有同名文件时保留工作区版本） |
| 角色说明 | 工作区 `subagents.yaml`（优先）或 `agents/subagents.yaml` |
| 注入规则（全员默认） | `agents/rules/`（[rules/README.md](rules/README.md)） |
| 技能 | `.xrk/skills/<name>/SKILL.md`，或按 **agent-skillhub** 写入工作区 |
| 工作区 Core | `agents/workspace/core/` → 工作区 `core/`；写法 **agent-core-dev**（可读 `.cursor/skills/xrk-*`） |
| 配方 | `agents/recipes/*.yaml` |

配置：`ai-workflow.yaml` → `agentWorkspace` · `recipes` · `security` · `context`。工程契约：[docs/agent-context.md](../docs/agent-context.md)。运营说明：[docs/agents.md](../docs/agents.md)。
