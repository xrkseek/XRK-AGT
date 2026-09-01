# ADR-0002: Agent loop 使用 `@xrkseek/harness` 模块

- **Status:** Accepted
- **Date:** 2026-09-01
- **Tags:** harness, module, callAI

## 决策

1. **唯一 tool 环**：`import '@xrkseek/harness'` → `createAgent` / tool pipeline（`callAI` 与 `/v1`+MCP workflows）。
2. **保留** workflow 业务（`chat.js`、MCP 经 `MCPServer`）。
3. **集成面**：进程内 SDK 模块；不以 Face/HTTP 旁路或 `agentBackend` / `loopBackend` 开关切换 loop。
4. **LLM 工厂**：单次补全（无 MCP 的 `/v1` client-tools 透传、流式透传）；tool 环不在工厂内。
5. **依赖**：AGT 只装 `@xrkseek/harness`（npm / Release tarball）；不深链叶包。

## 相关

[harness-module-loop.md](../harness-module-loop.md) · [status.md](../status.md)
