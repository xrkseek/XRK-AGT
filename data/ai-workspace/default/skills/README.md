# `.xrk/skills/` — 产品 Agent 技能种子

办事助手模型用的技能包（`SKILL.md`）。首次启用工作区时同步到 `data/ai-workspace/{id}/skills/`（缺啥补啥，不覆盖已有）。

| 路径 | 用途 |
|------|------|
| `core/` | 基础包（agent-core / tools / core-dev / skillhub / build-skill / memory…） |
| 本目录其它包 | 办公扩展等 `office-*` |

配置：`ai-workflow.yaml` → `agentWorkspace.customSkillRoots`（默认 `.xrk/skills/core` + `.xrk/skills`）。

Coding Agent 请用 `.cursor/skills/xrk-*`，不要把维护者 skill 写进本树。契约：[docs/agents.md](../docs/agents.md)。
