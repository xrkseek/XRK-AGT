# ADR-0002: Agent loop 使用 `@xrkseek/harness` 模块

- **Status:** Accepted
- **Date:** 2026-09-01
- **Reviewed:** 2026-09-12（与代码一致）
- **Tags:** harness, module, callAI

## 决策

1. **唯一 tool 环**：`import '@xrkseek/harness'` → `createAgent` / tool pipeline（`callAI` 与 `/v1`+MCP workflows）。
2. **保留** workflow 业务（`core/system-Core/workflow/chat.ts` 等、MCP 经 `MCPServer`）。
3. **MCP 执行不迁 SDK `createMcpClient`**：schema/执行仍 `MCPToolAdapter` → `MCPServer.handleToolCall`（统一 policies / toolScan / approval）。Harness 只做 ToolRegistry + continueTurn；远程 MCP 仍走 AGT `remote-mcp` 挂到本仓 MCPServer。
4. **集成面**：进程内 SDK 模块；不以 Face/HTTP 旁路或 `agentBackend` / `loopBackend` 开关切换 loop。
5. **LLM 工厂**：单次补全（无 MCP 的 `/v1` client-tools 透传、流式透传）；tool 环不在工厂内。
6. **依赖**：AGT 只装 `@xrkseek/harness`（当前钉 **0.3.3**；npm / Release tarball）；不深链叶包。

## 现状核对（2026-09-12）

| 断言 | 代码事实 |
|------|----------|
| 唯一 tool 环 | `harness-module-loop.ts` · `ai-workflow.ts` 调 `runHarnessModuleLoop` |
| 禁止 `createMcpClient` | 仅注释边界；无业务调用（`mcp-tool-adapter.ts` / harness-module-loop 头注） |
| 版本钉 | `package.json` → `"@xrkseek/harness": "0.3.3"` |
| 无 backend 开关 | 仓内无 `agentBackend` / `loopBackend` 切换 loop |
| 能力矩阵 | [status.md](../status.md) Agent 节 · [harness-module-loop.md](../harness-module-loop.md) |

## 相关

[harness-module-loop.md](../harness-module-loop.md) · [status.md](../status.md) · [0001](./0001-host-is-not-agent.md)
