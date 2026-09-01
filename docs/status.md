# 能力状态（诚实矩阵）

> **读者**：框架维护者 · Core · 集成者  
> **关联**：[harness-module-loop.md](harness-module-loop.md) · [底层架构设计.md](底层架构设计.md)

三态：**能跑 / 未稳 / 未做**。只登记现行能力。

## Host

| 能力 | 状态 | 说明 |
|------|------|------|
| AgentRuntime Host | 能跑 | HTTP/WS/多 bot；非 LLM loop（ADR-0001） |
| Tasker / Core 扩展点 | 能跑 | 可用 `.ts`（`--experimental-strip-types`；同名优先 `.ts`） |

## Agent

| 能力 | 状态 | 说明 |
|------|------|------|
| `@xrkseek/harness` 模块 loop | 未稳 | `callAI` / Web `/v1` / `/v1`+MCP；持久 session（`data/harness-sessions`）· 步内 live SSE（`assistant/chunk`）· compaction · adapter · safety · llmRetry · toolSettle · dangling · denyTools · hooks · vision |
| `/v1` 无 MCP（工厂透传） | 能跑 | 单次补全；流式/非流式透传 `tool_calls` |
| 出站 `contextWindow` 裁剪 | 能跑 | 与 harness soft budget 叠加 |
| `chat.js` / mergeWorkflows | 能跑 | |
| harness 步内流式 tool 事件 | 能跑 | OpenAI `stream=true` 透传 `assistant/chunk` · 完整 `mcp_tools`（args/result）；Anthropic/Responses 仍整段 JSON |

## MCP

| 能力 | 状态 | 说明 |
|------|------|------|
| MCPServer（经模块 loop） | 能跑 | 门禁在 `handleToolCall` |

*最后更新：2026-09-01*
