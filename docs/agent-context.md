# Agent 运行链与上下文组成

> **源码**：`src/infrastructure/ai-workflow/chat-pipeline.js` · `ai-workflow.js` · `core/system-Core/workflow/chat.js` · `src/utils/agent-workspace.js` · `core/system-Core/lib/ai-assistant-runtime.js` · `core/system-Core/http/ai.js`  
> **读者**：框架维护者 · Core 开发 · 办事助手运维  
> **关联**：[agents.md](agents.md)（运营）· [ai-workflow.md](ai-workflow.md)（基类/Loader）· [mcp-guide.md](mcp-guide.md)（MCP 运维）· 根 [AGENTS.md](../AGENTS.md)（写框架/Core）  
> **概念课径**（应用向，非学位课表）：vibe-learn 第五章 · 本文 §0 与之对齐

本文只写**现行契约**：一次完整 Agent 跑通时，消息怎么排、工作区/rules/skills 怎么进 prompt、工具能力怎么合并。行为以代码为准。

---

## 0. 概念地图（与工程落点）

先分清四层，避免把产品案例或知识外挂误当成「智能体本体」：

```
知识（可选）     经典 RAG：retrieve → augment → generate（可不经工具环）
行动语法         工具调用（tool calling）：模型点菜，运行时下厨
插接标准         MCP：发现/授权/调用外部工具与资源
控制循环         Agent loop：选行动 → 执行 → 观察 → 再决定（本仓主路径）
图编排（可选）   DAG / 条件边：复杂依赖时用；本仓主对话路径不是通用图编辑器
驯服             Rules 全文 · Skills 目录 · AGENTS.md · 子代理清单
脚手架（旁支）   如 Pi harness：对照学习，非本仓先修
```

| 概念 | 本仓落点 | 勿混淆 |
|------|----------|--------|
| 经典 RAG | 记忆/知识库等工作流；或 `tools.read` 读小文档 | 不依赖智能体循环 |
| 工具调用 | LLM 工厂 `tool_calls` + `registerMCPTool` | 不是 MCP 本身 |
| MCP | 宿主侧注册与远程 `remote-mcp.*` | 不是「检索协议」 |
| 智能体循环 | 多轮 `tool_calls` · `maxToolRounds` · `onAfterToolRound` | **禁止**文本假 ReAct |
| 图编排 | 固定消息三层 + 工具白名单；复杂 DAG 在 Core/外挂 | 不是知识图谱 |
| 上下文工程 | `assembleChatLlmMessages` + Workspace 预算 | 窗内一切，不单向量库 |
| Rules / Skills | `agents/rules/` 全文；技能**目录** + `tools.read` | 根 `AGENTS.md` 不进办事助手链 |
| harness 案例（Pi 等） | 仅对照；本仓默认 **有** MCP | 旁支，非升级路径 |

应用向学习课径见 vibe-learn 第五章（`core/vibe-learn`）；**契约以本文与代码为准**。

---

## 1. 两入口，一热路径

| 入口 | 文件 | 职责 |
|------|------|------|
| 群聊 / 消息 | `core/system-Core/plugin/ai.js` → `runChatAgent` | 触发、抽文本 → `chat.process({ mergeWorkflows })` |
| HTTP 控制台 | `core/system-Core/http/ai.js`（v3） | 已有 `messages` → 工作区注入 → `LLMFactory` + 工具白名单 |

插件**不**手组上下文；组合点在：

```
runChatAgent
  → AiWorkflow.process({ mergeWorkflows })
  → mergeWorkflows（合并 mcpTools）
  → ChatStream.execute
  → assembleChatLlmMessages
  → callAI（LLM + MCP 工具环）
```

配置：`data/ai/config.yaml`（`ai_config`）的 `mergeWorkflows`（默认 `memory` / `database` / `tools`）；开放模式下 `web` / `browser`（`frameworkToolSurface`）可自动进白名单；`remote-mcp.*` 须像普通 workflow 一样显式列入（控制台勾选或请求体 `workflow.workflows`）。

---

## 2. 能力怎么合并（mergeWorkflows）

`AiWorkflowLoader.mergeWorkflows`：克隆 chat 原型，把副流 `mcpTools` 挂进合成实例（副流工具名前缀如 `tools.read`）。

| 来源 | 作用 |
|------|------|
| chat 自带 | reply / poke / 群管 / 发图文件等通道工具 |
| `mergeWorkflows` | memory · database · tools · desktop · `remote-mcp.*`… |
| `frameworkToolSurface` | web · browser 等仅在开放模式自动进白名单 |
| `remote-mcp.*` | 与 workflow 同等，须显式列入 |

`mergeWorkflows` 决定**手上有什么工具**；下文 Workspace 决定**按什么规矩、先读哪本手册**。

`tools` 副流工具面（`tools.*`）：`read` / `grep` / `search_replace` / `write` / `delete_file` / `list_files` / `run`，以及 `apply_edit` / `verify` / `repo_map` / `update_todos`。副流 `buildSystemPrompt` 经 `collectAuxiliaryStreamPrompts` 注入 chat system；细则见 [mcp-guide.md](mcp-guide.md)、技能 `agent-tools`。

---

## 3. LLM 消息三层（assembleChatLlmMessages）

实现：`chat-pipeline.js`。顺序固定，利于 prompt cache：

| 层 | 方法 | 放什么 |
|----|------|--------|
| **1. 骨架** | `buildChatContext` | `system`（人设 + MCP 协议 + 工作区）+ 当前 user 骨架（可含多模态） |
| **2. 笔录** | `mergeMessageHistory` | 群/会话历史块 + `[当前消息]` |
| **3. 易变** | `buildEnhancedContext` | 时间 / 会话 / 主人 / 随机旁观 → **独立 user**，不塞 system |

### 3.1 system 再拆

`ChatStream.buildSystemPrompt` → `finalizeSystemPromptContent`：

1. chat 人设与「须调 MCP、勿口头假装」协议  
2. 副流辅助说明（`collectAuxiliaryStreamPrompts`：tools/memory…）  
3. **`# Workspace context`**（见 §4）

### 3.2 历史笔录

- 来源：`messageHistory` + `syncHistoryFromAdapter`  
- 行格式：`【我】` / `【我·工具·名】` / `昵称(QQ)[ID:…]`  
- 工具轨迹：`recordToolCallResult` 写入历史，供下一轮延续（不往用户气泡贴「使用了」）

### 3.3 HTTP v3 差异

不走群历史组装；对请求 `messages` 做违禁词、多模态合并后，直接 `mergeAgentWorkspaceIntoMessages`，再用 `workflows` / streams 控制工具白名单（`execute` / `hybrid` / `passthrough`）。

---

## 4. Workspace context（rules / skills / 工作区）

实现：`src/utils/agent-workspace.js` → `buildAgentWorkspaceSection`。  
开关与预算：`ai-workflow.yaml` → `agentWorkspace`。

**不进本链**：仓库根 `AGENTS.md`、`.cursor/rules`、`.cursor/skills`（给 **Coding Agent** / 维护者，见 [SKILL_INDEX](../.cursor/skills/SKILL_INDEX.md)）。

| 磁盘 | 角色 |
|------|------|
| `data/ai-workspace/{id}/` | 运行时工作区（首次从 `agents/workspace` 种子复制；含 `skills/`、`rules/`、`core/`） |
| `agents/rules/` ∪ 工作区 `rules/` | 共享护栏直接读 `agents/rules/`；工作区仅为用户加法（同名才覆盖） |
| `.xrk/skills/` + 工作区 `skills/` | 技能目录（name + location）；细则靠 `tools.read`；安装见 agent-skillhub |
| 工作区 `core/<Core>/plugin/` 等 | 业务插件/API（与仓库/子服 core 一并扫描；写法 **agent-core-dev**，编码真源只读 `.cursor/skills/xrk-*`） |
| `agents/microagents/` | triggers 命中则**整段注入**（如 plugin-write）；不靠 tools.read |

### 注入顺序（固定）

```
1. assistant     — AGENTS.md · SOUL/USER/IDENTITY/TOOLS/ENV/HEARTBEAT
                   · memory/今天.md、昨天.md · MEMORY.md（主会话）
2. contextFiles  — 配置额外 md
3. rules         — agents/rules（共享）∪ 工作区 rules/（用户加法；同路径覆盖）
4. Skills        — <available_skills> 目录（maxSkillsPromptChars；可 compact）
5. Agents        — subagents Primary / Subagents 清单
```

`agentWorkspace.workflows: []` = 全部入口注入；若列出 `chat` / `v3` 等，仅这些 `streamName` 注入。

### Skills 语义

注入的是目录卡，不是整本 `SKILL.md`：任务匹配 → `tools.read(location)` → 再调 MCP。  
与 Rules 分工：Rules = 常驻护栏；Skills = 按需手册。

---

## 5. 工具环与出站

`callAI` → `prepareOutboundMessages` → `LLMFactory.createClient().chat/chatStream`：`tool_calls` 时按 `mcpToolMode` 中游执行 MCP，多轮直到正文或 `onAfterToolRound` 提前结束（如 reply 已发出）。工具轮用尽时各客户端可再发一轮无工具 finalize。

### 5.1 出站消息链（固定）

```
slash 展开（/recipe · /recipes …）
  → assemble 消息三层
  → toolPair（旧 tool 结果投影，不改持久历史）
  → compaction（辅/主模型摘要 + 可选 backup / session sidecar）
  → contextWindow 尾部裁剪
  → LLM
```

配置：`ai-workflow.context.compaction` · `context.toolPair` · `context.chatHistory` · Provider `contextWindow`。  
实现：`ai-workflow.js` `prepareOutboundMessages` · `context-compaction.js` · `tool-pair-compact.js` · `chat-pipeline.js`。

### 5.2 策略与安全

| 能力 | 配置 | 落点 |
|------|------|------|
| 运行时策略 | `policies[]` | `runtime-policy.js`：`provider.use` / `tool.call` / `mcp.connect`；`ask` 工具仍注入，执行时审批或拒绝 |
| 威胁扫描 | `security.toolScan` | `tool-security-inspect.js`（默认开） |
| 交互审批 | `security.approval`（默认 **false**） | 主人私聊 `#批准` / `#批准id`；关则 ask=拒绝（主人可 bypass） |
| 执行门禁 | — | **统一**在 `MCPServer.handleToolCall`（LLM / HTTP / WS / JSON-RPC） |

### 5.3 斜杠与配方

- `/recipes` · `/recipe <id> [k=v]`：`slash-commands.js`；列表类可短路直接 reply
- 种子：`agents/recipes/*.yaml`；`recipes.scheduleEnabled` 时 cron 由 `recipe-schedule` 插件注册（默认只打日志）

### 5.4 工具环概念

| 概念 | 本仓落点 |
|------|----------|
| **智能体循环** | 工厂客户端多轮 `tool_calls`；`maxToolRounds`（多客户端默认约 7）；**禁止**文本假 ReAct（见 [ai-workflow.md](ai-workflow.md)） |
| **智能体图编排** | 固定消息三层 + 工具白名单环；复杂 DAG 在 Core / 外挂 |
| **harness 对照** | 本仓默认有 MCP + `mergeWorkflows`；对照即可 |

出站：`reply` 工具优先；否则 `_resolveOutboundText` + `sendMessages`；再 `recordAIResponse` 写回历史。

---

## 6. 特性落点速查

| 想改 / 想懂 | 落点 |
|-------------|------|
| 触发策略、人设、merge 列表 | `data/ai/config.yaml` · `ai_config` |
| 工作区注入开关与预算 | `ai-workflow.yaml` → `agentWorkspace` |
| 压缩 / toolPair / 历史条数 | `ai-workflow.yaml` → `context.*` |
| 策略 / 扫描 / 审批 | `policies` · `security.*` |
| 配方 cron | `recipes.scheduleEnabled` · `agents/recipes/` |
| 语气 / 红线 | 工作区 `AGENTS.md` |
| 称呼 / 偏好 | `USER.md` · `memory/MEMORY.md` |
| 行为规则全文 | `agents/rules/`（共享直接注入）∪ 工作区 `rules/`（用户加法） |
| 技能细则（产品 Agent） | `.xrk/skills/` 或工作区 `skills/`（装技能：agent-skillhub） |
| Coding Agent 技能 | `.cursor/skills/xrk-*`（**不**注入办事助手） |
| 托管技能同步 | 主人 `#skills更新`（托管按种子覆盖；自建不动）；锁 `.xrk/managed-skills-lock.json` |
| 角色路由提示 | `subagents.yaml` |
| 消息组装顺序 | `assembleChatLlmMessages` |
| 工具合并 | `AiWorkflowLoader.mergeWorkflows` |
| 工具轮上限 / 轮后钩子 | LLM 工厂客户端 `maxToolRounds` · `onAfterToolRound` |
| MCP 新文件工具 | `tools.apply_edit` / `verify` / `repo_map` / `update_todos` |

运营向说明见 [agents.md](agents.md)；基类与 Loader 见 [ai-workflow.md](ai-workflow.md)；MCP 运维见 [mcp-guide.md](mcp-guide.md)。

---

## 7. 文档与技能分工（避免混读者）

| 真源 | 读者 | 写什么 | 不写什么 |
|------|------|--------|----------|
| **本文** | 框架 / Core / 运维 | 跑通消息/工作区/出站/安全契约 | 办公 skill 细则、Cursor 放码 |
| [ai-workflow.md](ai-workflow.md) | 框架开发 | `AiWorkflow` / Loader / 配置键 | 办事语气 |
| [agents.md](agents.md) | 用户 / 运维 | 怎么用、改种子/工作区 | 出站实现细节（链到本文） |
| [mcp-guide.md](mcp-guide.md) | 运维 / 集成 | MCP 工具清单与排错 | 上下文注入顺序 |
| `.xrk/skills/**` | **产品 Agent 模型** | 工具/场景怎么干活 | `.cursor`、工厂、三准则 |
| `.cursor/skills/xrk-*` | **Coding Agent** | 改本仓怎么放码 | 注入到办事助手 prompt |
| 根 [AGENTS.md](../AGENTS.md) | Cursor / Core | skill 路由与放码 | 运行时 prompt 注入 |

*最后更新：2026-08-04*
