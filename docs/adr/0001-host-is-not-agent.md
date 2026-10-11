# ADR-0001: AgentRuntime 是 Host，不是 agent loop

- **Status:** Accepted
- **Date:** 2026-09-01
- **Reviewed:** 2026-09-12（与代码一致）
- **Tags:** host, naming, boundaries

## 背景

`src/agent-runtime.ts`（运行 `dist/src/agent-runtime.js`）名为 AgentRuntime，实际职责是 Express/WS、多 bot 注册、鉴权、Loader 挂载与全局 Proxy。真正的 LLM 控制循环在 AiWorkflow 热路径上的 `@xrkseek/harness` 模块（`runHarnessModuleLoop`）。命名混淆导致 Core 作者把「主机」当成「智能体」。

## 决策

1. **名词**：`AgentRuntime` = **Host**；agent loop = **`@xrkseek/harness`**（经 `AiWorkflow.callAI` / `/v1`）。
2. **禁止**：在 `agent-runtime.ts` / `RuntimeUtil` 上继续堆 LLM 轮次、工具结算、会话笔录真源。
3. **允许**：Host 继续拥有 Tasker、HTTP、插件调度、channel 出站（`e.reply`）。
4. **依赖方向（目标）**：`host` → `channels` → `workflow` → harness loop；Core 不深依赖 Host 私有工具当公共 API。

## 现状核对（2026-09-12）

| 断言 | 代码事实 |
|------|----------|
| Host ≠ loop | `src/agent-runtime.ts` 无 `runHarnessModuleLoop` / `createAgent` |
| loop 入口 | `src/infrastructure/ai-workflow/ai-workflow.ts` → `runHarnessModuleLoop` |
| 能力矩阵 | [status.md](../status.md) Host 节：非 LLM loop（本 ADR） |

## 后果

- 办事助手 / chat 工作流 → `callAI` → harness。
- 见 [0002](./0002-harness-module-first.md) · [harness-module-loop.md](../harness-module-loop.md)。

## 相关

[agent-runtime.md](../agent-runtime.md) · [agent-context.md](../agent-context.md) · [底层架构设计.md](../底层架构设计.md)
