---
name: xrk-mcp
description: 当你需要理解或扩展 MCP 工具（注册/分组/远程连接）、执行门禁与 LLM tool calling 关系时使用。
---

> **读者：Coding Agent**。办事助手「怎么调某个工具」见 `agents/skills/standard/core/agent-tools`。

## 文档与代码

`docs/mcp-guide.md`、`docs/mcp-config-guide.md`、`core/system-Core/http/mcp.js`、`commonconfig/system/system-ai-workflow.js`（`ai-workflow.mcp`）

## 要点

- 工作流内 `registerMCPTool` → `MCPToolAdapter` → OpenAI tools。
- **执行前门禁**统一在 `MCPServer.handleToolCall` → `inspectToolCallSecurity`（policies + toolScan + 可选审批）；勿只在适配器拦一层。
- v3 / LLMFactory 的 tool calling 最终执行 MCP 工具。
- 远程 MCP：`ai-workflow.mcp.remote` **或** workflow 模块 `export function getMcpServers()`（Loader → 插件 MCP 表）；连接前 `mcp.connect`（`checkMcpConnectAllowed`）。HTTP 用 `fetchWithPolicy`（`#utils/fetch-with-retry.js`），无 `RuntimeUtil.fetch`。
- 产品 Agent 挂远程：**优先 JS `getMcpServers`**，勿改系统 yaml（见 `agents/.../agent-core-dev` §3.5）。
- `tools` 增强：`apply_edit` / `verify` / `repo_map` / `update_todos`（实现 `workspace/apply-edit-blocks.js` · `repo-map-lite.js`）。

## Node 26

- MCP HTTP/远程连接走全局 `fetch` + `AbortSignal.timeout`；代理见 `proxy-utils.js`。
- 工具 handler 判错用 `Error.isError` / `normalizeError`（skill **`xrk-node-runtime`**）。
