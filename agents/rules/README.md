# agents/rules — 产品共享护栏（运行时直接注入）

办事助手 system prompt 合并（`includeRules`）：

1. **本目录**（产品共享；改这里立即生效，**不**拷进工作区）  
2. **`data/ai-workspace/{id}/rules/`**（用户自建加法；**同相对路径才会覆盖**本目录同名文件）

各 `.mdc` 含 `xrk-inject: false`：XRK-Harness 打开本仓做 Core 开发时**不** standing 注入；XRK-AGT 运行时仍读本目录。

| | `agents/rules/` | 工作区 `rules/` | `.cursor/rules/` |
|--|-----------------|-----------------|------------------|
| 给谁 | 办事助手（全员默认） | 该工作区用户定制 | Cursor 维护者 |
| 谁改 | 产品 / 仓库维护 | 用户自己 | Coding Agent |
| 如何生效 | 注入时直接读本目录 | 注入时合并；同名覆盖共享 | IDE 上下文 |

## 文件

| 文件 | 作用 |
|------|------|
| `reply-style.mdc` | 先结论、再步骤、给验收点 |
| `response-safety.mdc` | 隐私、删改、外发、命令、路径边界 |
| `group-chat.mdc` | QQ/群：何时回、一条一答 |
| `delivery.mdc` | 交付路径、验收、缺能力降级 |
| `workspace-dev.mdc` | 只写工作区；可读项目根了解框架 |

工作区如何自建规则：见 `agents/workspace/rules/README.md`。技能：`.xrk/skills/` · [docs/agents.md](../docs/agents.md)
