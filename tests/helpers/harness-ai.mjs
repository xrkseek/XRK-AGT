/**
 * Harness / AI 测试稳定入口（仍用 .mjs 跑）。
 * 契约：用 package.json `imports`（`#infrastructure/*` · `#utils/*` → dist），
 * 禁止手写相对 dist 链（易碎、与 # 入口双轨）。
 *
 * 类型面（tsc 后）：`dist/src/infrastructure/ai-workflow/*.d.ts` · `dist/src/utils/sse-openai.d.ts`
 * @see docs/harness-module-loop.md · docs/框架测试指南.md
 */

/** @type {const} */
export const HARNESS_AI_SPECIFIERS = {
  loop: '#infrastructure/ai-workflow/harness-module-loop.js',
  resolve: '#infrastructure/ai-workflow/harness-resolve.js',
  session: '#infrastructure/ai-workflow/harness-session-registry.js',
  aiWorkflow: '#infrastructure/ai-workflow/ai-workflow.js',
  remoteMcp: '#infrastructure/ai-workflow/remote-mcp.js',
  chatToolStreams: '#infrastructure/ai-workflow/chat-tool-streams.js',
  loader: '#infrastructure/ai-workflow/loader.js',
  workflowCtx: '#infrastructure/ai-workflow/workflow-request-context.js',
  sseOpenai: '#utils/sse-openai.js',
  aiV3: '#utils/http/ai-v3-utils.js',
  tokenBudget: '#utils/llm/message-token-budget.js',
  mcpAdapter: '#utils/llm/mcp-tool-adapter.js',
};

export {
  splitOutboundMessages,
  seedSessionFromHistory,
  extractAssistantToolCalls,
  isLikelyReadOnlyTool,
  mapHarnessReasoningEffort,
  resolveToolSettle,
  resolveHarnessSafety,
  resolveDenyToolNames,
  resolveHarnessLlmRetry,
  resolveHarnessCompaction,
  resolveTurnHooks,
  resolveCreateAgentMappedOptions,
  __resolveMaxStepsForTests,
  withRouteReasoning,
  slimMessagesForExistingSession,
  runHarnessModuleLoop,
  mapHarnessContinueTurnError,
  foldUsageFromEvents,
  createLlmFromConfig,
  buildHarnessUserTurn,
  attachPipelinePolicy,
} from '#infrastructure/ai-workflow/harness-module-loop.js';

export {
  createOpenAiWorkflowDeltaHandler,
  createHarnessLiveSessionEventHandler,
  createOpenAIChunk,
} from '#utils/sse-openai.js';

export {
  shouldUseHarnessModuleLoop,
  shouldWantOpenAiLiveSse,
} from '#utils/http/ai-v3-utils.js';

export { trimMessagesToTokenBudget, resolveInputTokenBudget } from '#utils/llm/message-token-budget.js';

export { runWithWorkflowRequestContext, getWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js';

/** @param {keyof typeof HARNESS_AI_SPECIFIERS} key */
export function importHarnessAi(key) {
  const spec = HARNESS_AI_SPECIFIERS[key];
  if (!spec) throw new Error(`unknown harness-ai specifier: ${key}`);
  return import(spec);
}
