# 办事助手说明

办事助手是 XRK 运行时里的对话 Agent：在群聊、控制台或 stdin 里查资料、写文稿、整理表格、管理工作区文件。  
种子在 `agents/`；运行时用 `data/ai-workspace/{id}/`（首次从种子复制，之后以工作区为准）。

## 相关文档

| 文件 | 读者 | 内容 |
|------|------|------|
| **本文** | 用户 / 运维 / 维护者 | 办事助手怎么用、改哪里、实现索引 |
| **[agent-context.md](agent-context.md)** | 框架 / Core / 运维 | 概念地图 + 消息三层 + 出站/安全 + Workspace + 工具环 |
| 仓库根 [`AGENTS.md`](../AGENTS.md) | **Coding Agent** / Core 开发 | 框架放码、`xrk-*` skill（**不**注入办事助手） |
| `agents/skills/standard/**` | **产品 Agent 模型** | 工具/场景细则（`tools.read`） |
| `~/.cursor/AGENTS.md` | 本机所有项目 | 全局工程师技能、代理、生图等 |
| `agents/workspace/AGENTS.md` → `data/ai-workspace/{id}/AGENTS.md` | 办事助手模型 | 注入 prompt 的办事规则 |
| `core/<core>/AGENTS.md`（若有） | 产品 Agent | 该产品人格与工具边界 |

调办事助手行为：工作区或 `agents/` 种子（见「想改助手行为时」）。  
写框架 / Core：根 [`AGENTS.md`](../AGENTS.md)。  
**一次 Agent 跑通、消息三层、Workspace/rules/skills 注入**：见 **[agent-context.md](agent-context.md)**（工程契约真源）。

---

## 上下文怎么进模型（摘要）

完整链路与代码落点见 [agent-context.md](agent-context.md)。运营侧只需记住：

| 进 system 的块 | 来源 | 改哪里 |
|----------------|------|--------|
| 人设 / MCP 说话纪律 | chat 工作流 | `ai_config.persona` · chat 协议文案 |
| 工作区人格与记忆 | `data/ai-workspace/{id}/` | AGENTS / USER / MEMORY… |
| 行为规则全文 | `agents/rules/`（直接注入）∪ 工作区 `rules/`（用户加法；同路径才覆盖） | 共享改 `agents/rules/`；定制只写工作区 |
| 技能目录 | `agents/skills/standard/` + 工作区 `skills/` | 细则靠 `tools.read`；安装见 **agent-skillhub** |
| 角色路由提示 | `subagents.yaml` | 不启隔离子会话 |

工具并集：`ai_config.mergeWorkflows`（开放模式可并入 web/browser；`remote-mcp.*` 须显式列入）。

---

## 能做什么

| 场景 | 举例 |
|------|------|
| **写与改** | 邮件、纪要、简报、对外稿、FAQ、润色与校对 |
| **表格与演示** | 整理数据、做表、图表说明、PPT 大纲与内容 |
| **查与汇总** | 联网检索、资料对比、调研摘要（带来源） |
| **规划** | 任务拆解、方案与验收点 |
| **工作区整理** | 在专属文件夹里找草稿、改文档、列目录 |
| **环境相关** | 本机 Python、文档转换、浏览器/桌面工具是否可用 |

助手先匹配技能，再调用 MCP 工具。工作范围是当前工作区文件与通道工具。

---

## 怎么用

### 在哪里说话

- **群聊 / QQ 机器人**：@ 或按群规则触发；短问短答、纪要、提醒。
- **控制台 / stdin**：长任务、连续改稿、批量整理工作区。
- **HTTP / 设备通道**：见各产品 Core 说明。

### 斜杠与配方

- `/recipes`：列出可用配方  
- `/recipe <id> [k=v …]`：注入该配方的 instructions + prompt（种子在 `agents/recipes/`）  
- 需已触发助手（@ / 前缀等）；配方 cron 见配置 `recipes.scheduleEnabled`（默认关，开启后插件默认只打日志）

主人命令：`#skills更新`（托管包按种子覆盖；用户自建 `skills/` 不动）。

### 危险命令审批（可选）

默认：`security.approval.enabled=false`，危险/策略 ask 直接拒绝（主人调用可放行）。  
开启后主人私聊回复 `#批准` / `#批准id`（空格可选）；插件 `tool-approval`。

### 工作区文件工具（摘）

合并 `tools` 时可用：`repo_map`（陌生仓定位）、`apply_edit` / `verify`（批量改与校验）、`update_todos`（多步待办）。全表见技能 **agent-tools** 或 [mcp-guide.md](mcp-guide.md)。

### 工作区

| 路径 | 用途 |
|------|------|
| `SOUL.md`、`USER.md`、`IDENTITY.md` | 人格、称呼、身份 |
| `AGENTS.md` | 办事规则（注入模型） |
| `TOOLS.md`、`ENV.md` | 本机路径、邮箱习惯、依赖状态 |
| `HEARTBEAT.md` | 心跳任务清单 |
| `memory/` | 当天流水 + 长期偏好（`MEMORY.md`） |
| `skills/` | 技能副本（种子同步；工作区已有同名技能时保留工作区版本） |
| `core/` | 工作区业务 Core（`workspace-Core/…`；Loader 扫描；见 **agent-core-dev**） |
| `rules/` | 用户自建护栏（加法；与 `agents/rules/` 合并，同名才覆盖） |
| `docs/` 等 | 文稿与数据（按需自建） |
| `subagents.yaml`（可选） | 覆盖种子角色清单 |

日常改 `data/ai-workspace/{id}/`。更新所有人默认模板时改仓库 `agents/` 种子。

### 想改助手行为时

| 想改什么 | 改哪里 |
|----------|--------|
| 语气、红线、群聊习惯 | 工作区 `AGENTS.md` |
| 称呼、偏好 | `USER.md`、`memory/MEMORY.md` |
| 本机路径、邮箱、依赖 | `TOOLS.md`、`ENV.md` |
| 注入用行为规则 | 共享改 `agents/rules/`；本工作区加法写 `rules/`（同名可覆盖共享） |
| 技能细则 | 工作区 `skills/`，或 `agents/skills/standard/` |
| 安装 / 同步技能 | **agent-skillhub**；主人 `#skills更新`（托管覆盖；自建不动） |
| 工作区 Core 业务 | 工作区 `core/workspace-Core/`（**agent-core-dev**；可读项目根 `.cursor/skills/xrk-*`）；种子 `agents/workspace/core/` |
| 主助手 / 专项角色 | 工作区 `subagents.yaml`（优先）或 `agents/subagents.yaml` |
| 注入开关与字符预算 | `ai-workflow.yaml` → `agentWorkspace` |

---

## 技能类别

技能是办事手册；对话里有 `<available_skills>`，按需 **read** 对应 `SKILL.md`（每任务约 1–3 个）。

| 类别 | 做什么 | 代表技能 |
|------|--------|----------|
| **基础** | 路由、工具、装技能、写 Core、回答格式、记忆、浏览器 | agent-core、agent-tools、agent-skillhub、agent-build-skill、agent-core-dev、answer-format、agent-search、agent-memory、agent-browser |
| **沟通** | 邮件、外联、内部通知、会议与纪要 | office-email、office-outreach、office-internal、office-meeting、office-meeting-prep、office-transcribe |
| **文稿** | 文档、润色、调研、计划、简报 | office-doc、office-docx、office-copy、office-proofread、office-research、office-plan、office-briefing |
| **对外发布** | 通稿、更新说明、FAQ、改写 | office-press、office-changelog、office-faq、office-repurpose |
| **表格** | 表格逻辑、Excel、CSV、图表 | office-sheet、office-xlsx、office-csv、office-chart |
| **演示与 PDF** | PPT、PDF | office-pptx、office-pdf |
| **环境与工作区** | 依赖、工作区文件、Shell/Web/桌面 | office-env-setup、office-env-workspace、office-env-shell、office-env-web、office-env-desktop |
| **长文与专业写作** | 长文档、技术写作 | office-long-doc、office-tech-writing |

自建/商店装到 **`data/ai-workspace/{id}/skills/`**（SkillHub：`skillhub install <名> --dir <该目录>`，见 [skillhub 安装说明](https://skillhub.cn/install/skillhub.md) · **agent-skillhub**）。SKILL 写法见 **agent-build-skill**；工作区 Core 业务见 **agent-core-dev**（`core/workspace-Core/`，可导航读 `.cursor/skills/xrk-*`）。路由表：`agents/skills/standard/core/agent-core/SKILL.md`。

---

## Agents 清单

`subagents.yaml` 把办事角色写成注入提示，供模型路由。

| 名称 | 类型 | 何时用 | 说明 |
|------|------|--------|------|
| **assistant** | 主助手 | 日常问答、办公、读写工作区 | 默认入口：先匹配技能再动手 |
| **plan** | 主助手 | 方案、拆任务、评风险 | 输出步骤与验收点，少改文件 |
| **research** | 专项 | 开放问题、对比、联网核实 | 摘要并标来源 |
| **docs** | 专项 | 邮件、纪要、docx/xlsx/pdf/pptx | 文稿与办公格式 |
| **workspace** | 专项 | 找材料、改草稿、整理目录 | 工作区文件 |

工作区根目录的 `subagents.yaml` 优先于 `agents/subagents.yaml`。

---

## 改工作区文件

实现：`src/utils/base-tools.js`、`core/system-Core/workflow/tools.js`（增强：`apply-edit-blocks.js`、`repo-map-lite.js`）。

| 情况 | 工具 | 说明 |
|------|------|------|
| 陌生仓定位 | `repo_map` | 先于盲目 `list_files`；可带 `query` |
| 改已有文件局部 | `search_replace`（`oldText` / `newText`） | 唯一匹配或 `replaceAll`；首选 |
| 多文件 / 多处批量改 | `apply_edit`（SEARCH/REPLACE 块） | 可 `dryRun`；改后建议 `verify` |
| 改后校验 | `verify` | 需 `tools.file.runEnabled`；传 lint/test 命令 |
| 新建文件 | `write` | 自动建目录 |
| 整篇覆盖已有文件 | `write` + `overwrite=true` | 用户要求全文改版时 |
| 查找 | `read` / `grep` / `list_files` | 改前确认路径 |
| 多步任务 | `update_todos` | 整表覆盖；status 含 pending/completed 等 |

---

## 隐私与确认

- 密钥、token、身份证号等不进记忆或群聊；`.env` 不当普通文稿改。
- 删除文件、对外发送、本机执行命令前：说明影响并征得确认。
- 未核实数据标「待核实」。
- 群聊：被 @、被提问、或能给出可执行价值时再回复。

---

## 实现索引（维护者）

| 主题 | 路径 |
|------|------|
| 仓库种子 | `agents/` · [agents/README.md](../agents/README.md) |
| 运行时工作区 | `data/ai-workspace/{id}/` |
| 运行链 / 上下文组成 | **[agent-context.md](agent-context.md)** |
| 注入逻辑 | `src/utils/agent-workspace.js` |
| 路径常量 | `src/utils/agent-workspace-paths.js` |
| 配置默认 | `config/default_config/ai-workflow.yaml` → `agentWorkspace` |
| Schema | `core/system-Core/commonconfig/system/system-ai-workflow.js` |
| 文件工具 | `core/system-Core/workflow/tools.js`、`src/utils/base-tools.js` |
| Agents 清单种子 | `agents/subagents.yaml` |
| 技能种子 | `agents/skills/standard/`（含 agent-skillhub） |
| 共享行为规则 | `agents/rules/`（运行时直接注入，不拷进工作区） |
| 工作区规则（用户加法） | `data/ai-workspace/{id}/rules/` |
| Microagents（triggers 命中整段注入） | `agents/microagents/`（如 **plugin-write**；写工作区 Core 时少 read 长 skill） |
| MCP | [mcp-guide.md](mcp-guide.md)、[mcp-config-guide.md](mcp-config-guide.md) |
| 工作流基类 | [ai-workflow.md](ai-workflow.md) |
| 框架开发 | 根 [AGENTS.md](../AGENTS.md) · `.cursor/skills/xrk-*` |

Prompt 注入顺序与 `include*` 门控：见 [agent-context.md](agent-context.md)；实现 `agent-workspace.js`、`ai-workflow.yaml`。
