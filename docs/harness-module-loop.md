# AGT ↔ `@xrkseek/harness` 模块 loop

> **源码**：`src/infrastructure/ai-workflow/harness-module-loop.js` · `harness-resolve.js` · `ai-workflow.js` · `core/system-Core/http/ai.js`  
> **读者**：框架维护者 · Core  
> **关联**：[status.md](status.md) · [agent-context.md](agent-context.md) · [adr/0002-harness-module-first.md](adr/0002-harness-module-first.md) · Harness 仓 `docs/integrators/agt-bridge.md`

办事助手与带 MCP 的 `/v1` 的 **agent loop** 嵌入 `@xrkseek/harness` SDK。通道业务（`chat.js`、MCPServer、Tasker）仍在 AGT；压缩、步内重试、厂商适配器、session safety 用 SDK 轮子。

## 依赖

| 包 / 入口 | 角色 |
|-----------|------|
| `@xrkseek/harness` | npm 公共 SDK：`createAgent` · tools · session · compaction · 厂商 adapter |
| `xrkh`（`@xrkseek/harness-cli`） | 独立产品；AGT **不**作为库 import |

```bash
pnpm add @xrkseek/harness@0.1.26

# 或 Release tarball
pnpm add https://github.com/xrkseek/XRK-harness/releases/download/v0.1.26/xrkseek-harness-0.1.26.tgz
```

未发布构建可用环境变量 `XRK_HARNESS_SDK` 指向 **SDK 入口文件的绝对路径**（见 `harness-resolve.js`）。勿把本机目录布局写进文档或提交进仓。

> **注意**：只依赖 SDK 门面；勿把 `@xrkseek/core-*` / `llm-*` 叶包写进 `package.json`。

## 现行数据流

```
chat.js / mergeWorkflows / MCP
  → AiWorkflow.callAI
  → runHarnessModuleLoop
       → 原生 adapter（DeepSeek / Anthropic / Responses / Gemini / 否则 OpenAI-compatible）
       → createAgent（compaction · llmRetry · safety · tool spill）
       → continueTurn

POST /v1/* + body.workflow.workflows
  → 同上（MCP 工具面）

POST /v1/* 无 workflows 且无 body.tools
  → 同上（Web 控制台纯对话）

POST /v1/* 无 workflows 但有 body.tools
  → `LLMFactory` 单次补全；`tool_calls` 透传客户端
```

| 入口 | Loop |
|------|------|
| `AiWorkflow.callAI`（含 `chat` 工作流） | harness |
| `/v1` 且声明 `workflows` | harness |
| `/v1` 无 `workflows`、无 `tools`（Web 控制台） | harness |
| `/v1` 无 `workflows`、有 client `tools` | `LLMFactory` 单次补全；`tool_calls` 透传客户端 |

出站：`prepareOutboundMessages` 先按 `contextWindow` 裁剪；harness 再按 `CompactionOptions`（soft budget + 自动摘要）管理 session。群聊笔录：`context.chatHistory`。

跨 turn：`sessionKey`（`callAI` 用会话键；`/v1` 用 `xrk_session_id` / `conversation_id` / workspace）→ `createPersistentSessionStore`（`data/harness-sessions`）。同键复用 session，**不再**整段 seed 客户端 history；同 session + 同 workflows 复用 ToolRegistry/Pipeline（有 `registerTools` 钩子则每轮重建）。

`/v1` + OpenAI `stream=true`：订阅 `assistant/chunk` / `tool/call` / `tool/result` 写 live SSE（`mcp_tools` 含 arguments + result），turn 结束后 finish + `[DONE]`。Anthropic / Responses 仍整段 JSON。

## harness 轮子（AGT 已接）

| SDK 能力 | AGT 映射 |
|----------|----------|
| `createPersistentSessionStore` | `harness-session-registry`；`sessionKey` → 固定 session id |
| `store.append` 监听 | `/v1` live SSE（`assistant/chunk` · `tool/call` · `tool/result`） |
| `createDeepSeekAdapter` 等 | `createLlmFromConfig` 按 provider / path 选型 |
| `peekRoute` / `reasoningEffort` | Provider `reasoningEffort` · `thinkingType` → adapter + route |
| `compaction` | Provider `contextWindow` → `maxRequestTokens` / `keepTokens` |
| `llmRetry` | `llm.retry.maxAttempts` / `maxRetries` |
| `toolSettle` / `maxParallelToolCalls` | `parallel_tool_calls` · `maxParallelToolCalls` |
| `settleDanglingTools` | turn 结束后补齐悬挂 `tool/result` |
| `deriveMessages` | 无 `result.text` 时从 session 回退正文 |
| `signal` / `usage` | AbortSignal 透传；session usage → `/v1` usage |
| `ContextOverflowError` / `UnsupportedContentError` | 映射 `context_overflow` / `unsupported_content`（callAI 吞并记日志） |
| body `tools` | 与 MCP 并存时注册 schema（不服务端执行） |
| session safety | createAgent 默认开启（loop / mistake）；`safety` / `harnessSafety` 可覆盖或 `false` 关闭 |
| `toolResultMaxInlineBytes` | 默认 64KiB spill |
| `isConcurrencySafe` | 只读名启发式（`read`/`list`/…）可并行 settle |
| `concludesTurn` | `*.reply` / `reply` 成功后结束本 turn |
| `ToolPipeline` 自动批准 | IM / bot 不阻塞交互式审批 |
| `createPolicyToolCallGuard` | `denyTools` / `denyToolNames` 数组 → pipeline guard |
| `assertToolCallsSettled` | dangling settle 后再校验；失败仅 warn |
| `listDanglingToolCalls` | settle 前 warn 悬挂工具名 |
| `beforeUserMessage` / `prepareUserContent` / `assemble` | apiConfig 或 `stream.harnessBeforeUserMessage` 等 |
| `registerTools` | apiConfig 或 `stream.registerHarnessTools(registry, ctx)` 扩展注册 |
| `MCPToolAdapter` → `ToolRegistry` | AGT MCP 仍进 `MCPServer` |
| `createMemoryAttachmentStore` + `resolveImage` | OpenAI `image_url` data-URL → harness ContentBlock |
| history seed | OpenAI `tool_calls` / `role:tool` → `assistant/message` · `tool/call` · `tool/result` |

## 落点

| 文件 | 职责 |
|------|------|
| `harness-module-loop.js` | 拆 messages · seed · adapter · compaction · `continueTurn` |
| `harness-session-registry.js` | 持久 store · `sessionKey` 复用 · append 监听 |
| `harness-resolve.js` | 加载 SDK |
| `ai-workflow.js` → `callAI` | 办事助手入口 |
| `http/ai.js` | `/v1` + live SSE / JSON |
| `MCPToolAdapter` | schema + 执行进 `MCPServer` |

## 配置

| 字段 | 用途 |
|------|------|
| Provider `maxToolRounds` | harness `maxSteps`；**无工具时强制 `maxSteps=1`** |
| Provider `contextWindow` | 出站 trim + harness soft compact |
| Provider `reasoningEffort` / `thinkingType` | DeepSeek thinking wire + loop `reasoningEffort` |
| `parallel_tool_calls` / `maxParallelToolCalls` | harness `toolSettle` / 并发上限 |
| `llm.retry` | harness 步内 `llmRetry`；`enabled:false` → `false`；`maxAttempts` → `maxRetries=maxAttempts-1`；`delay`/`retryOn` 映射 SDK |
| `safety` / `harnessSafety` | `false` 关；对象 → `SessionSafetyOptions`（mistake / loopDetection） |
| `denyTools` / `denyToolNames` | 工具名黑名单（SDK policy guard） |
| `registerTools` / `onGuard` / `onPre` | 扩展注册与 pipeline 钩子 |
| `beforeUserMessage` / `prepareUserContent` / `assemble` | 透传 createAgent / runTurn |
| `context.chatHistory` | 群聊笔录 |
| 请求体 `workflow.workflows` | `/v1` MCP 白名单 |
| `sessionKey` / `xrk_session_id` | 跨 turn 复用 harness session |

### 扩展点（小）

```js
// apiConfig 或 AiWorkflow 实例方法
registerTools(registry, { harness, workflows, stream, config }) { /* registry.register(...) */ }
beforeUserMessage(store, sessionId) { /* inject */ }
onGuard(ctx) { /* allow | deny | abstain */ }
```

`SessionSafetyLimitError` → 结果带 `safetyLimited: true`（不抛穿业务）；`SessionBusyError` → `code: session_busy`。

## 相关文档

- [status.md](status.md) · [agent-context.md](agent-context.md) · [mcp-guide.md](mcp-guide.md) · [factory.md](factory.md)
