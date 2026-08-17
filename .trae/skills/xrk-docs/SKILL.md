---
name: xrk-docs
description: 需要快速定位「该看哪份文档/哪段代码/哪份配置」时使用；提供文档导航与权威路径。
---

> **读者：Coding Agent**。产品模型技能在 `agents/skills/`，勿与本索引混用。

## 导航

主索引：`docs/README.md`。分层边界：`docs/底层架构设计.md`。启动链：`docs/startup.md`。  
技能读者分流：`.cursor/skills/SKILL_INDEX.md`。

| 主题 | 文档 |
|------|------|
| **开发首读** | `docs/runtime-surface.md`、`docs/coding-style.md`、`docs/base-classes.md` |
| **Cursor / 本仓开发入口** | 根 `AGENTS.md`、`.cursor/skills/SKILL_INDEX.md` |
| **办事助手（群聊/控制台）** | `docs/agents.md`、`agents/README.md`（运营） |
| **Agent 跑通 / 出站 / 安全** | `docs/agent-context.md` ⭐ |
| **写法 / 性能** | `docs/coding-style.md`、skill `xrk-coding-style` |
| **Node 26** | `docs/node-26-runtime.md`、skill `xrk-node-runtime` |
| **Core www / 挂载** | skill `xrk-www-compat`、`docs/www-mount.md` |
| 启动 / 引导 | `docs/startup.md` |
| 文档规范 | `docs/DOCSTYLE.md` |
| 数据库 | `docs/database.md` |
| 扩展点 / 基类 | `docs/框架可扩展性指南.md`、`docs/base-classes.md` |
| Loader 模式 | `docs/infrastructure-shared.md` |
| LLM / v3 / finalize | `docs/factory.md`、skill `xrk-llm`、`core/system-Core/http/ai.js` |
| 工作流 / 压缩 / 策略 | `docs/ai-workflow.md`、skill `xrk-ai-workflow` |
| system-Core | `docs/system-core.md` |
| HTTP | `docs/http-api.md`、`docs/http-business-layer.md`、`docs/server.md` |
| 鉴权 | `docs/AUTH.md` |
| MCP | `docs/mcp-guide.md`、`docs/mcp-config-guide.md`、skill `xrk-mcp` |
| 配置 | `docs/config-base.md`、skill `xrk-config` |
| 目录树 | `PROJECT_OVERVIEW.md` |

## 回答规范

- 配置类：给出 YAML 路径 + 字段 + 最小示例。
- 行为类：给出代码文件 + 函数/类名。
- 文档与代码冲突：以代码为准。
- 分清读者：改代码 → `xrk-*`；办事助手怎么用工具 → `agents/skills/.../agent-tools`。
