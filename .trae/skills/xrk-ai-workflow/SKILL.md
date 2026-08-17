---
name: xrk-ai-workflow
description: 当你需要开发/调试 AiWorkflow 工作流、出站压缩、策略安全、RAG 上下文增强、MCP 工具作用域时使用。
---

> **读者：Coding Agent**（改 `src` / `core`）。产品模型工具用法见 `agents/skills/.../agent-tools`。

## 文档与代码

- 契约：[docs/agent-context.md](../../../docs/agent-context.md) · [docs/ai-workflow.md](../../../docs/ai-workflow.md)
- 代码：`src/infrastructure/ai-workflow/ai-workflow.js` · `loader.js` · `chat-pipeline.js`

## 工作流

- 路径：`core/*/workflow/*.js`（`AiWorkflowLoader` 扫描，**不用** `ai-workflow.streamDir`）
- 配置：`data/server_bots/{port}/ai-workflow.yaml`；schema `commonconfig/system/system-ai-workflow.js`
- 工具：LLM tool calling + MCP；`registerMCPTool` → `this.mcpTools`；远程挂载：`export function getMcpServers()`（同模块）或 yaml `mcp.remote`
- **LLM**：`LLMFactory.createClient().chat/chatStream`（**不**经 Python 子服）
- **出站**：`prepareOutboundMessages` = toolPair → compaction(+sidecar) → contextWindow trim
- **策略/安全**：`policies[]` · `security.toolScan` · `security.approval`；执行门禁在 `MCPServer.handleToolCall`
- **斜杠**：`slash-commands.js`（`/recipe`）；microagents：`trigger-microagents.js`
- Shell：`#utils/exec-async.js`；禁止 `promisify(exec)`（skill **`xrk-node-runtime`**）

## 与子服务端关系

子服务端为**可选** Python 扩展；AiWorkflow 核心链路不依赖子服务。业务 Core 可通过 `AgentRuntime.callSubserver` 调用子服务 `apis/` 接口。
