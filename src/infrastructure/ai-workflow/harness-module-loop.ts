/**
 * Embed @xrkseek/harness agent loop for AiWorkflow.callAI and /v1+MCP workflows.
 * AGT keeps chat.js / MCPServer; harness owns continueTurn, compaction, retries, adapters.
 *
 * MCP boundary: schema+execute stay MCPToolAdapter → MCPServer.handleToolCall.
 * Do NOT migrate execution to SDK createMcpClient / registerMcpTools (ADR-0002).
 */
import type {
  AgentHandle,
  AttachmentStore,
  ContentBlock,
  CreateAgentOptions,
  LlmAdapter,
  LlmChatRequest,
  MessageContent,
  SessionEvent,
  SessionStore,
} from '@xrkseek/harness';
import RuntimeUtil from '#utils/runtime-util.js';
import { MCPToolAdapter } from '#utils/llm/mcp-tool-adapter.js';
import { resolveInputTokenBudget } from '#utils/llm/message-token-budget.js';
import { parseToolCallArguments } from '#utils/llm/parse-tool-arguments.js';
import { createFetchWithProxy } from '#utils/llm/proxy-utils.js';
import { normalizeError } from '#utils/normalize-error.js';
import { importHarnessSdk } from './harness-resolve.js';
import {
  acquireHarnessSession,
  attachHarnessSessionListener,
} from './harness-session-registry.js';

type OpenAiChatMessage = {
  role?: string
  content?: unknown
  name?: string
  tool_call_id?: string
  toolCallId?: string
  tool_calls?: unknown
  toolCalls?: unknown
  reasoning?: unknown
  isError?: boolean
  [key: string]: unknown
}

type LlmConfig = Record<string, unknown> & {
  model?: string
  chatModel?: string
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  provider?: string
  factoryType?: string
  path?: string
  temperature?: number
  maxTokens?: number
  max_tokens?: number
  timeout?: number
  timeoutMs?: number
  headers?: Record<string, string>
  reasoningEffort?: unknown
  reasoning_effort?: unknown
  thinkingType?: unknown
  thinking_type?: unknown
  sessionKey?: string
  conversationId?: string
  workflows?: string[]
  tools?: unknown
  maxToolRounds?: number
  retry?: unknown
  signal?: AbortSignal
  parallel_tool_calls?: boolean
  parallelToolCalls?: boolean
  maxParallelToolCalls?: number
  safety?: unknown
  harnessSafety?: unknown
  denyTools?: unknown
  denyToolNames?: unknown
  toolResultMaxInlineBytes?: number
  /** Face `session/jobs` — optional passthrough to createAgent. */
  jobs?: CreateAgentOptions['jobs']
  onSessionEvent?: unknown
  onGuard?: unknown
  onPre?: unknown
  registerTools?: unknown
  beforeUserMessage?: unknown
  prepareUserContent?: unknown
  assemble?: unknown
  _harnessLlm?: LlmAdapter
}

type ApiConfig = LlmConfig

type LoopStream = {
  name?: string
  _getToolWorkflowNames?: () => string[]
  harnessBeforeUserMessage?: (...args: unknown[]) => unknown
  harnessPrepareUserContent?: (...args: unknown[]) => unknown
  registerHarnessTools?: (...args: unknown[]) => unknown
}

type OpenAiContentPart = string | {
  type?: string
  text?: string
  image_url?: { url?: string }
  url?: string
  image?: { url?: string }
  [key: string]: unknown
}

type OpenAiFunctionTool = {
  type?: string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  function?: {
    name?: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

type HarnessToolCall = { id: string; name: string; arguments: unknown }

type PendingImage = { mediaType: string; data: Uint8Array }
type BlockDraft = { type: 'text'; text: string } | { type: 'image'; _pending: number }

type HarnessUserTurnResult = {
  text: string
  userContent: MessageContent
  resolveImage?: LlmChatRequest['resolveImage']
  hasImage?: boolean
}

type CompactionOptionsLike = {
  auto?: boolean
  maxRequestTokens?: number
  keepTokens?: number
  bufferTokens?: number
}

type LlmRetryOptionsLike = {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  retryableCodes?: string[]
  mode?: 'always' | 'normal'
}

type SessionSafetyOptionsLike = {
  loopDetection?: false | Record<string, unknown>
  mistake?: Record<string, unknown>
}

type ToolSettleOptionsLike = {
  toolSettle?: 'serial' | 'parallel'
  maxParallelToolCalls?: number
}

type ToolRegistryLike = {
  register: (tool: {
    name: string
    description: string
    parameters: Record<string, unknown>
    isConcurrencySafe?: (args: unknown) => boolean
    execute: (args: unknown, signal?: AbortSignal) => Promise<{
      content: string
      isError?: boolean
      concludesTurn?: boolean
    }>
  }) => void
  get?: (name: string) => unknown
  has?: (name: string) => boolean
  list?: () => readonly unknown[]
}

type ToolPipelineLike = {
  setApprovalHandler: (handler: (() => Promise<{ approved: boolean }>) | undefined) => void
  onGuard: (guard: (ctx: unknown) => unknown) => () => void
  onPre: (handler: (ctx: unknown) => unknown) => () => void
}

type DanglingToolCallLike = { call?: HarnessToolCall }

type HarnessSdk = {
  createAgent: (options: CreateAgentOptions) => AgentHandle
  createToolRegistry: () => ToolRegistryLike
  createToolPipeline: () => ToolPipelineLike
  createMemoryAttachmentStore: () => AttachmentStore
  flattenText?: (content: MessageContent) => string
  contentHasImage?: (content: MessageContent) => boolean
  asContentBlocks?: (content: MessageContent) => ContentBlock[]
  createDeepSeekAdapter: (opts: Record<string, unknown>) => LlmAdapter
  createAnthropicAdapter: (opts: Record<string, unknown>) => LlmAdapter
  createOpenAiResponsesAdapter: (opts: Record<string, unknown>) => LlmAdapter
  createGeminiAdapter: (opts: Record<string, unknown>) => LlmAdapter
  createOpenAiCompatibleAdapter: (opts: Record<string, unknown>) => LlmAdapter
  createPolicyToolCallGuard: (names: string[]) => (ctx: unknown) => unknown
  createPolicyToolPre?: (engine: unknown) => (ctx: unknown) => unknown
  createPolicyEngine?: (opts: { rules: unknown[] }) => unknown
  denyToolNames?: (names: string[]) => unknown
  askToolNames?: (names: string[]) => unknown
  runToolDetailed?: (input: {
    registry: ToolRegistryLike
    pipeline?: ToolPipelineLike
    call: { id: string; name: string; arguments?: unknown }
  }) => Promise<{ result: { content?: string; isError?: boolean }; skippedBody?: boolean }>
  listDanglingToolCalls: (events: readonly SessionEvent[]) => readonly DanglingToolCallLike[]
  settleDanglingTools: (store: SessionStore, sessionId: string) => unknown
  assertToolCallsSettled: (events: readonly SessionEvent[]) => void
  deriveMessages: (events: readonly SessionEvent[]) => OpenAiChatMessage[]
  isContextOverflowError: (err: unknown) => boolean
  isUnsupportedContentError: (err: unknown) => boolean
  SessionSafetyLimitError?: new (...args: unknown[]) => Error
  SessionBusyError?: new (...args: unknown[]) => Error
  ContextOverflowError?: new (...args: unknown[]) => Error
  UnsupportedContentError?: new (...args: unknown[]) => Error
}

type RegisterToolsHookCtx = {
  harness: HarnessSdk
  stream: LoopStream
  config: LlmConfig
  apiConfig: ApiConfig
  workflows: string[]
  sessionId: string
}

type ToolSurfaceEntry = {
  fp: string
  tools: ToolRegistryLike
  pipeline: ToolPipelineLike
  mcpCount: number
  clientCount: number
  hookCount: number
}

type FoldedMcpTool = {
  id: string
  name?: string
  arguments?: unknown
  result?: unknown
  isError?: boolean
}

type RunHarnessModuleLoopOptions = {
  stream: LoopStream
  messages: unknown
  config: LlmConfig
  apiConfig?: ApiConfig
}

type ContinueTurnInput = Parameters<AgentHandle['continueTurn']>[0] & {
  userContent?: MessageContent
}

function flattenContent(content: unknown) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text') return p.text || '';
      return '';
    }).join('');
  }
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const textVal = (content as { text?: unknown }).text;
    if (textVal != null) return String(textVal);
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * OpenAI multimodal parts -> harness MessageContent + resolveImage (SDK attachment store).
 * Text-only stays string; data-URL images become ContentBlock image refs.
 *
 * SDK `flattenText` / `contentHasImage` / `asContentBlocks` apply to MessageContent only —
 * they cannot replace the OpenAI `image_url` → attachment conversion below.
 */
export async function buildHarnessUserTurn(harness: HarnessSdk, rawContent: unknown): Promise<HarnessUserTurnResult> {
  const fallbackText = flattenContent(rawContent);
  if (!Array.isArray(rawContent)) {
    return { text: fallbackText, userContent: fallbackText };
  }
  const parts = rawContent as OpenAiContentPart[];
  const imageParts = parts.filter(
    (p) => p && typeof p === 'object' && (p.type === 'image_url' || p.type === 'image'),
  );
  if (!imageParts.length) {
    return { text: fallbackText, userContent: fallbackText };
  }

  const store = harness.createMemoryAttachmentStore();
  const blocks: BlockDraft[] = [];
  const pending: PendingImage[] = [];

  for (const p of parts) {
    if (typeof p === 'string') {
      if (p) blocks.push({ type: 'text', text: p });
      continue;
    }
    if (p?.type === 'text') {
      if (p.text) blocks.push({ type: 'text', text: String(p.text) });
      continue;
    }
    const url = p?.image_url?.url ?? p?.url ?? p?.image?.url;
    if (!url || typeof url !== 'string') continue;
    const m = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!m) {
      // Non-data URL: keep a text hint (do not fetch remote in loop)
      blocks.push({ type: 'text', text: '[image omitted: non-data URL]' });
      continue;
    }
    const mediaType = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
    const data = Uint8Array.from(Buffer.from(m[2].replace(/\s+/g, ''), 'base64'));
    pending.push({ mediaType, data });
    blocks.push({ type: 'image', _pending: pending.length - 1 });
  }

  const refs = pending.length
    ? await store.saveImages(pending.map((x) => ({
      data: x.data,
      mediaType: x.mediaType as Parameters<AttachmentStore['saveImages']>[0][number]['mediaType'],
    })))
    : [];
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text') out.push(b);
    else if (b.type === 'image') {
      const ref = refs[b._pending];
      if (ref) out.push({ type: 'image', attachment: ref });
    }
  }

  const drafted: MessageContent = out.length
    ? (harness.asContentBlocks ? harness.asContentBlocks(out) : out)
    : fallbackText;
  const text = (harness.flattenText ? harness.flattenText(drafted) : '') || fallbackText;
  const hasImage = harness.contentHasImage
    ? harness.contentHasImage(drafted)
    : Array.isArray(drafted) && drafted.some((b) => b?.type === 'image');

  // No real attachment refs (e.g. only non-data URL hints) → stay on text path.
  if (!hasImage) {
    return { text, userContent: text };
  }

  const resolveImage: LlmChatRequest['resolveImage'] = async (attachmentId: string) => {
    const stored = await store.readImage(attachmentId);
    return {
      mediaType: stored.ref.mediaType,
      data: stored.data,
      ref: stored.ref,
    };
  };
  return {
    text,
    userContent: drafted,
    resolveImage,
    hasImage: true,
  };
}


/**
 * Session already holds prior turns — keep standing system + latest user only.
 * Avoids re-trim / re-seed of OpenAI history on reused sessionKey.
 */
export function slimMessagesForExistingSession(messages: unknown): OpenAiChatMessage[] {
  const list = Array.isArray(messages) ? messages as OpenAiChatMessage[] : [];
  const systems: OpenAiChatMessage[] = [];
  let lastUser: OpenAiChatMessage | null = null;
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') systems.push(m);
    else if (m.role === 'user') lastUser = m;
  }
  return lastUser ? [...systems, lastUser] : [...systems];
}

/**
 * Split AGT OpenAI-style messages -> system + prior turns + latest user.
 */
export function splitOutboundMessages(messages: unknown) {
  const list = Array.isArray(messages) ? messages as OpenAiChatMessage[] : [];
  const systems: string[] = [];
  const history: OpenAiChatMessage[] = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role === 'system') {
      const t = flattenContent(m.content).trim();
      if (t) systems.push(t);
      continue;
    }
    history.push(m);
  }
  let latestUser = '';
  let userRawContent: unknown = '';
  while (history.length) {
    const last = history[history.length - 1];
    if (last?.role === 'user') {
      userRawContent = last.content;
      latestUser = flattenContent(last.content);
      history.pop();
      break;
    }
    // trailing tool/assistant without new user - keep in history seed
    break;
  }
  if (!latestUser.trim() && history.length) {
    const last = history[history.length - 1];
    userRawContent = last?.content;
    latestUser = flattenContent(last?.content);
    history.pop();
  }
  return {
    system: systems.join('\n\n'),
    history,
    userText: latestUser,
    userRawContent,
  };
}

function parseToolArguments(raw: unknown) {
  const parsed = parseToolCallArguments(raw);
  if (parsed.ok) return parsed.args;
  return parsed.args && typeof parsed.args === 'object' ? parsed.args : { _raw: String(raw) };
}

/** OpenAI-style assistant.tool_calls -> harness ToolCall[]. */
export function extractAssistantToolCalls(message: OpenAiChatMessage | null | undefined): HarnessToolCall[] | undefined {
  const raw = message?.tool_calls ?? message?.toolCalls;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((tcRaw, i) => {
    const tc = tcRaw as Record<string, unknown> & {
      id?: string
      toolCallId?: string
      name?: string
      arguments?: unknown
      function?: { name?: string; arguments?: unknown }
    };
    const id = tc?.id ?? tc?.toolCallId ?? `seed_call_${i}`;
    const name = tc?.function?.name ?? tc?.name ?? 'unknown';
    const args = tc?.function?.arguments ?? tc?.arguments ?? {};
    return {
      id: String(id),
      name: String(name),
      arguments: parseToolArguments(args),
    };
  });
}

/**
 * Seed OpenAI-style history into harness session events so deriveMessages
 * rebuilds prior tool turns (assistant/message + tool/call + tool/result).
 */
export function seedSessionFromHistory(store: SessionStore, sessionId: string, history: OpenAiChatMessage[]) {
  let turn = 0;
  let lastTurnId = 'seed_0';
  for (const m of history) {
    const role = m?.role;
    if (!m || role === 'system') continue;
    const text = flattenContent(m.content);
    const toolCalls = role === 'assistant' ? extractAssistantToolCalls(m) : undefined;
    if (role === 'user') {
      if (!text) continue;
      const turnId = `seed_${turn}`;
      const ts = Date.now() + turn;
      store.append(sessionId, {
        type: 'user/message',
        ts,
        turnId,
        content: text,
      } as SessionEvent);
      lastTurnId = turnId;
      turn += 1;
      continue;
    }
    if (role === 'assistant') {
      if (!text && !toolCalls?.length) continue;
      const turnId = lastTurnId || `seed_${turn}`;
      const ts = Date.now() + turn;
      store.append(sessionId, {
        type: 'assistant/message',
        ts,
        turnId,
        stepId: `seed_step_${turn}`,
        content: text || '',
        ...(toolCalls ? { toolCalls } : {}),
        ...(m.reasoning != null && String(m.reasoning).trim()
          ? { reasoning: String(m.reasoning) }
          : {}),
      } as SessionEvent);
      if (toolCalls) {
        for (let i = 0; i < toolCalls.length; i += 1) {
          store.append(sessionId, {
            type: 'tool/call',
            ts: ts + i + 1,
            turnId,
            stepId: `seed_step_${turn}_tc_${i}`,
            call: toolCalls[i],
          } as SessionEvent);
        }
      }
      continue;
    }
    if (role === 'tool') {
      const callId = m.tool_call_id ?? m.toolCallId;
      if (!callId) continue;
      const name = m.name || 'tool';
      const ts = Date.now() + turn;
      store.append(sessionId, {
        type: 'tool/result',
        ts,
        turnId: lastTurnId,
        stepId: `seed_step_${turn}_tr_${String(callId).slice(0, 24)}`,
        result: {
          toolCallId: String(callId),
          name: String(name),
          content: text || '',
          ...(m.isError ? { isError: true } : {}),
        },
      } as SessionEvent);
    }
  }
}

/** Name heuristic: read-ish MCP tools may settle in parallel. */
export function isLikelyReadOnlyTool(name: unknown) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (/(^|[._-])(write|create|update|delete|remove|send|reply|exec|run|put|post|patch|mutate)([._-]|$)/.test(n)) {
    return false;
  }
  return /(^|[._-])(read|get|list|search|query|find|fetch|stat|info|describe)([._-]|$)/.test(n);
}

function registerMcpTools(workflows: string[], registry: ToolRegistryLike) {
  const openAiTools = MCPToolAdapter.convertMCPToolsToOpenAI({ workflows }) as OpenAiFunctionTool[];
  for (const t of openAiTools) {
    const name = t?.function?.name;
    if (!name) continue;
    const description = t.function?.description || '';
    const parameters = t.function?.parameters || { type: 'object', properties: {} };
    const readOnly = isLikelyReadOnlyTool(name);
    const concludes = String(name).endsWith('.reply') || name === 'reply';
    registry.register({
      name,
      description,
      parameters,
      ...(readOnly ? { isConcurrencySafe: () => true } : {}),
      async execute(args: unknown) {
        const rawArgs = typeof args === 'string' ? args : JSON.stringify(args ?? {});
        const rows = await MCPToolAdapter.handleToolCalls(
          [{
            id: `call_${Date.now().toString(36)}`,
            function: { name, arguments: rawArgs },
          }],
          { workflows },
        );
        const content = rows?.[0]?.content ?? '';
        const isError = typeof content === 'string'
          && (content.includes('"success":false') || content.includes('"success": false'));
        return {
          content: String(content),
          ...(isError ? { isError: true } : {}),
          ...(concludes && !isError ? { concludesTurn: true } : {}),
        };
      },
    });
  }
  return openAiTools.length;
}

/** Map AGT effort -> harness DeepSeek effort identifiers. */
export function mapHarnessReasoningEffort(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === 'disabled') return 'off';
  if (v === 'low' || v === 'minimal') return 'low';
  if (v === 'max') return 'max';
  if (v === 'high' || v === 'medium' || v === 'xhigh') return 'high';
  return undefined;
}

function resolveDeepSeekThinkingDefaults(config: LlmConfig = {}) {
  const rawType = config.thinkingType ?? config.thinking_type;
  const type = rawType == null || rawType === ''
    ? undefined
    : String(rawType).trim().toLowerCase();
  const effort = mapHarnessReasoningEffort(
    config.reasoningEffort ?? config.reasoning_effort,
  );
  if (type === 'disabled' || effort === 'off') {
    return { thinking: 'disabled', ...(effort === 'off' ? { reasoningEffort: 'off' } : {}) };
  }
  if (effort) {
    return { thinking: 'enabled', reasoningEffort: effort };
  }
  if (type === 'enabled') {
    return { thinking: 'enabled' };
  }
  return true;
}

/** Attach peekRoute/ensureRoute so agent-loop can pass reasoningEffort into adapters. */
export function withRouteReasoning(llm: LlmAdapter, reasoningEffort: string | undefined, model: string): LlmAdapter {
  if (!reasoningEffort || !llm) return llm;
  const peekFn = llm.peekRoute?.bind(llm);
  const ensureFn = llm.ensureRoute?.bind(llm);
  const basePeek = peekFn ? () => peekFn() : () => undefined;
  const baseEnsure = ensureFn
    ? () => ensureFn()
    : () => ({ provider: llm.id || 'agt', model: model || '' });
  const wrapped: LlmAdapter = {
    id: llm.id,
    inputModalities: llm.inputModalities,
    chat: (req: LlmChatRequest) => llm.chat(req),
    ...(typeof llm.stream === 'function' ? { stream: (req: LlmChatRequest) => llm.stream!(req) } : {}),
    peekRoute() {
      const prev = basePeek() || {};
      return { ...prev, reasoningEffort } as NonNullable<ReturnType<NonNullable<LlmAdapter['peekRoute']>>>;
    },
    ensureRoute() {
      const prev = baseEnsure() || { provider: llm.id || 'agt', model: model || '' };
      return { ...prev, reasoningEffort } as ReturnType<NonNullable<LlmAdapter['ensureRoute']>>;
    },
  };
  return wrapped;
}

/** parallel_tool_calls -> createAgent toolSettle / maxParallelToolCalls. */
export function resolveToolSettle(config: LlmConfig = {}, apiConfig: ApiConfig = {}): ToolSettleOptionsLike {
  const parallel = apiConfig.parallel_tool_calls
    ?? apiConfig.parallelToolCalls
    ?? config.parallel_tool_calls
    ?? config.parallelToolCalls;
  const maxRaw = apiConfig.maxParallelToolCalls ?? config.maxParallelToolCalls;
  const max = Number(maxRaw);
  const out: ToolSettleOptionsLike = {};
  if (parallel === false) out.toolSettle = 'serial';
  else if (parallel === true) out.toolSettle = 'parallel';
  if (Number.isFinite(max) && max > 0) {
    out.toolSettle = out.toolSettle || 'parallel';
    out.maxParallelToolCalls = Math.floor(max);
  }
  return out;
}

/** Map AGT provider config -> harness native adapter when possible. */
export function createLlmFromConfig(
  harness: HarnessSdk,
  config: LlmConfig,
  options: { inputModalities?: readonly ('text' | 'image')[] } = {},
): LlmAdapter {
  const model = config.model || config.chatModel || '';
  const effort = mapHarnessReasoningEffort(
    config.reasoningEffort ?? config.reasoning_effort,
  );
  if (config._harnessLlm) {
    return withRouteReasoning(config._harnessLlm, effort, String(model || ''));
  }
  const baseUrl = String(config.baseUrl || config.base_url || '').replace(/\/+$/, '');
  const apiKey = config.apiKey || config.api_key || '';
  if (!baseUrl || !model) {
    throw new Error('harness loop needs config.baseUrl and config.model (from AGT provider)');
  }

  const fetchWithProxy = createFetchWithProxy(config as Parameters<typeof createFetchWithProxy>[0]);
  const common = {
    id: `agt:${config.provider || 'llm'}`,
    baseUrl,
    apiKey: apiKey ? String(apiKey) : undefined,
    model: String(model),
    temperature: config.temperature,
    maxTokens: config.maxTokens ?? config.max_tokens,
    timeoutMs: config.timeout ?? config.timeoutMs,
    headers: config.headers,
    ...(options.inputModalities ? { inputModalities: options.inputModalities } : {}),
    // 与 *LLMClient 共用 providers[].proxy，不读系统 HTTP(S)_PROXY
    ...(fetchWithProxy ? { fetch: fetchWithProxy } : {}),
  };

  const provider = String(config.provider || config.factoryType || '').toLowerCase();
  const pathHint = String(config.path || '').toLowerCase();

  let llm;
  if (/deepseek/.test(provider)) {
    llm = harness.createDeepSeekAdapter({
      ...common,
      deepseekThinking: resolveDeepSeekThinkingDefaults(config),
    });
  } else if (/anthropic|claude/.test(provider) || pathHint.includes('/messages')) {
    llm = harness.createAnthropicAdapter(common);
  } else if (/responses/.test(provider) || pathHint.includes('responses')) {
    llm = harness.createOpenAiResponsesAdapter(common);
  } else if (/gemini/.test(provider)) {
    llm = harness.createGeminiAdapter(common);
  } else {
    const thinking = resolveDeepSeekThinkingDefaults(config);
    llm = harness.createOpenAiCompatibleAdapter({
      ...common,
      ...((config.thinkingType != null || config.thinking_type != null
        || config.reasoningEffort != null || config.reasoning_effort != null)
        ? { deepseekThinking: thinking }
        : {}),
    });
  }

  return withRouteReasoning(llm, effort, String(model));
}

/**
 * Provider contextWindow → harness CompactionOptions（soft budget + auto summary）。
 * maxRequestTokens 与 prepareOutboundMessages 共用 resolveInputTokenBudget（见 agent-context §5.1）。
 */
export function resolveHarnessCompaction(config: LlmConfig = {}): CompactionOptionsLike | undefined {
  const maxRequestTokens = resolveInputTokenBudget(config);
  if (!maxRequestTokens || maxRequestTokens < 800) return undefined;
  const keepTokens = Math.max(
    2000,
    Math.min(12_000, Math.floor(maxRequestTokens * 0.45)),
  );
  return {
    auto: true,
    maxRequestTokens,
    keepTokens,
    bufferTokens: 2000,
  };
}

export function resolveHarnessLlmRetry(
  config: LlmConfig = {},
  apiConfig: ApiConfig = {},
): LlmRetryOptionsLike | false | undefined {
  const retry = apiConfig.retry ?? config.retry;
  if (retry === false || (retry && typeof retry === 'object' && (retry as { enabled?: boolean }).enabled === false)) {
    return false;
  }
  if (!retry || typeof retry !== 'object') return undefined;

  const retryObj = retry as Record<string, unknown>;
  const out: LlmRetryOptionsLike = {};
  // AGT maxAttempts = total tries including first; SDK maxRetries = retries after failure.
  if (retryObj.maxRetries != null) {
    const n = Number(retryObj.maxRetries);
    if (Number.isFinite(n) && n >= 0) out.maxRetries = Math.floor(n);
  } else {
    const attempts = Number(retryObj.maxAttempts ?? retryObj.attempts);
    if (Number.isFinite(attempts) && attempts >= 1) {
      out.maxRetries = Math.max(0, Math.floor(attempts) - 1);
    }
  }

  const delay = Number(retryObj.delay ?? retryObj.initialDelayMs);
  if (Number.isFinite(delay) && delay > 0) out.initialDelayMs = Math.floor(delay);

  const maxDelay = Number(retryObj.maxDelay ?? retryObj.maxDelayMs);
  if (Number.isFinite(maxDelay) && maxDelay > 0) out.maxDelayMs = Math.floor(maxDelay);

  if (Array.isArray(retryObj.retryableCodes) && retryObj.retryableCodes.length) {
    out.retryableCodes = retryObj.retryableCodes.map(String);
  } else if (Array.isArray(retryObj.retryOn) && retryObj.retryOn.length) {
    const codes = mapAgtRetryOnToCodes(retryObj.retryOn);
    if (codes) out.retryableCodes = codes;
  }

  if (retryObj.mode === 'always' || retryObj.mode === 'normal') out.mode = retryObj.mode;

  return Object.keys(out).length ? out : undefined;
}

/** AGT yaml retryOn -> harness retryableCodes. */
function mapAgtRetryOnToCodes(retryOn: unknown[]): string[] | undefined {
  const set = new Set<string>();
  for (const raw of retryOn) {
    const v = String(raw || '').toLowerCase();
    if (v === 'all') {
      return ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];
    }
    if (v === 'timeout') set.add('TIMEOUT');
    else if (v === 'network') set.add('TRANSPORT');
    else if (v === '5xx' || v === 'server') set.add('SERVER');
    else if (v === 'rate_limit' || v === '429') set.add('RATE_LIMIT');
    else if (v === 'empty') set.add('EMPTY_RESPONSE');
  }
  return set.size ? [...set] : undefined;
}

/**
 * Map AGT config -> createAgent `safety`.
 * `false` disables; object passes SessionSafetyOptions; omit -> SDK default.
 */
export function resolveHarnessSafety(
  config: LlmConfig = {},
  apiConfig: ApiConfig = {},
): false | SessionSafetyOptionsLike | Record<string, unknown> | undefined {
  const raw = apiConfig.safety
    ?? apiConfig.harnessSafety
    ?? config.safety
    ?? config.harnessSafety;
  if (raw === false) return false;
  if (!raw || typeof raw !== 'object') return undefined;
  const rawObj = raw as Record<string, unknown>;
  const out: SessionSafetyOptionsLike = {};
  if (rawObj.loopDetection === false) out.loopDetection = false;
  else if (rawObj.loopDetection && typeof rawObj.loopDetection === 'object') {
    out.loopDetection = rawObj.loopDetection as Record<string, unknown>;
  }
  if (rawObj.mistake && typeof rawObj.mistake === 'object') {
    out.mistake = rawObj.mistake as Record<string, unknown>;
  }
  return Object.keys(out).length ? out : rawObj;
}

/** Denylist names from apiConfig / config (policy createPolicyToolCallGuard). */
export function resolveDenyToolNames(config: LlmConfig = {}, apiConfig: ApiConfig = {}): string[] | undefined {
  const raw = apiConfig.denyTools
    ?? apiConfig.denyToolNames
    ?? config.denyTools
    ?? config.denyToolNames;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const names = raw.map((n) => String(n || '').trim()).filter(Boolean);
  return names.length ? names : undefined;
}

function resolveAbortSignal(config: LlmConfig = {}, apiConfig: ApiConfig = {}): AbortSignal | undefined {
  const outer = apiConfig.signal ?? config.signal ?? undefined;
  const timeoutMs = Number(apiConfig.timeout ?? config.timeout ?? config.timeoutMs);
  const parts = [];
  if (outer) parts.push(outer);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    parts.push(AbortSignal.timeout(Math.floor(timeoutMs)));
  }
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
}

/** Hooks → createAgent beforeUserMessage / prepareUserContent / assemble. */
export function resolveTurnHooks(stream: LoopStream = {}, config: LlmConfig = {}, apiConfig: ApiConfig = {}) {
  const beforeUserMessage = apiConfig.beforeUserMessage
    ?? config.beforeUserMessage
    ?? (typeof stream?.harnessBeforeUserMessage === 'function'
      ? stream.harnessBeforeUserMessage.bind(stream)
      : undefined);
  const prepareUserContent = apiConfig.prepareUserContent
    ?? config.prepareUserContent
    ?? (typeof stream?.harnessPrepareUserContent === 'function'
      ? stream.harnessPrepareUserContent.bind(stream)
      : undefined);
  const assemble = apiConfig.assemble ?? config.assemble;
  return {
    ...(typeof beforeUserMessage === 'function' ? { beforeUserMessage } : {}),
    ...(typeof prepareUserContent === 'function' ? { prepareUserContent } : {}),
    ...(assemble && typeof assemble === 'object' ? { assemble } : {}),
  };
}

/**
 * Map AGT config → CreateAgentOptions fields owned by the loop
 * (everything except sessionId/store/llm/tools/pipeline/system).
 * Keeps 0.3.3 option surface in one place for audit + tests.
 */
export function resolveCreateAgentMappedOptions(opts: {
  stream?: LoopStream
  config?: LlmConfig
  apiConfig?: ApiConfig
  toolCount?: number
  resolveImage?: LlmChatRequest['resolveImage']
}): Partial<
  Omit<CreateAgentOptions, 'sessionId' | 'store' | 'llm' | 'tools' | 'pipeline' | 'system'>
> & { maxSteps: number; toolResultMaxInlineBytes: number } {
  const config = opts.config ?? {};
  const apiConfig = opts.apiConfig ?? {};
  const stream = opts.stream ?? {};
  const toolCount = opts.toolCount ?? 0;

  const maxSteps = resolveMaxSteps(config, apiConfig, toolCount);
  const compaction = resolveHarnessCompaction(config);
  const llmRetry = resolveHarnessLlmRetry(config, apiConfig);
  const toolSettle = resolveToolSettle(config, apiConfig);
  const safety = resolveHarnessSafety(config, apiConfig);
  const turnHooks = resolveTurnHooks(stream, config, apiConfig);
  const jobs = apiConfig.jobs ?? config.jobs;
  const toolResultMaxInlineBytes = config.toolResultMaxInlineBytes
    ?? apiConfig.toolResultMaxInlineBytes
    ?? 64 * 1024;

  return {
    maxSteps,
    ...(safety !== undefined ? { safety: safety as CreateAgentOptions['safety'] } : {}),
    ...(compaction ? { compaction: compaction as CreateAgentOptions['compaction'] } : {}),
    ...(llmRetry !== undefined ? { llmRetry: llmRetry as CreateAgentOptions['llmRetry'] } : {}),
    ...toolSettle,
    ...(turnHooks as Pick<CreateAgentOptions, 'beforeUserMessage' | 'prepareUserContent' | 'assemble'>),
    ...(opts.resolveImage ? { resolveImage: opts.resolveImage } : {}),
    ...(jobs ? { jobs } : {}),
    toolResultMaxInlineBytes,
  };
}

function isHarnessSafetyLimitError(err: unknown, harness: HarnessSdk): err is Error & { reason?: string } {
  if (!err) return false;
  const norm = normalizeError(err);
  if (norm.name === 'SessionSafetyLimitError') return true;
  if (harness?.SessionSafetyLimitError && err instanceof harness.SessionSafetyLimitError) {
    return true;
  }
  return false;
}

function isHarnessBusyError(err: unknown, harness: HarnessSdk): err is Error {
  if (!err) return false;
  const norm = normalizeError(err);
  if (norm.name === 'SessionBusyError') return true;
  if (harness?.SessionBusyError && err instanceof harness.SessionBusyError) return true;
  return false;
}

export type HarnessContinueTurnErrorMap =
  | { action: 'safetyLimited'; message: string; reason?: string }
  | {
    action: 'throw'
    code: 'session_busy' | 'context_overflow' | 'unsupported_content'
    message: string
    cause: unknown
  }
  | { action: 'rethrow'; cause: unknown }

/**
 * Map continueTurn failures → AGT contract:
 * SessionSafetyLimitError → safetyLimited (soft)
 * SessionBusyError → code session_busy
 * ContextOverflowError → code context_overflow
 * UnsupportedContentError → code unsupported_content
 */
export function mapHarnessContinueTurnError(
  err: unknown,
  harness: Pick<
    HarnessSdk,
    | 'SessionSafetyLimitError'
    | 'SessionBusyError'
    | 'isContextOverflowError'
    | 'isUnsupportedContentError'
  > = {} as HarnessSdk,
): HarnessContinueTurnErrorMap {
  if (err == null) return { action: 'rethrow', cause: err };
  const norm = normalizeError(err);
  if (isHarnessSafetyLimitError(err, harness as HarnessSdk)) {
    const reason = typeof err === 'object' && err !== null && 'reason' in err
      && typeof (err as { reason?: unknown }).reason === 'string'
      ? (err as { reason: string }).reason
      : undefined;
    return {
      action: 'safetyLimited',
      message: norm.message || reason || 'limit',
      ...(reason ? { reason } : {}),
    };
  }
  if (isHarnessBusyError(err, harness as HarnessSdk)) {
    return {
      action: 'throw',
      code: 'session_busy',
      message: norm.message || 'session busy',
      cause: err,
    };
  }
  if (
    (typeof harness.isContextOverflowError === 'function' && harness.isContextOverflowError(err))
    || norm.name === 'ContextOverflowError'
  ) {
    return {
      action: 'throw',
      code: 'context_overflow',
      message: norm.message || 'context overflow',
      cause: err,
    };
  }
  if (
    (typeof harness.isUnsupportedContentError === 'function' && harness.isUnsupportedContentError(err))
    || norm.name === 'UnsupportedContentError'
  ) {
    return {
      action: 'throw',
      code: 'unsupported_content',
      message: norm.message || 'unsupported content',
      cause: err,
    };
  }
  return { action: 'rethrow', cause: err };
}

/** @internal tests — duck-type / instanceof helpers */
export function __isHarnessSafetyLimitErrorForTests(err: unknown, harness: HarnessSdk) {
  return isHarnessSafetyLimitError(err, harness);
}

/** @internal tests */
export function __isHarnessBusyErrorForTests(err: unknown, harness: HarnessSdk) {
  return isHarnessBusyError(err, harness);
}

/**
 * Optional extension: register extra tools after MCP / client schema tools.
 * Prefer apiConfig.registerTools(registry, ctx); stream.registerHarnessTools as fallback.
 */
function invokeRegisterToolsHook(registry: ToolRegistryLike, ctx: RegisterToolsHookCtx) {
  const { apiConfig, stream } = ctx;
  const fn = (typeof apiConfig.registerTools === 'function' ? apiConfig.registerTools : undefined)
    ?? (typeof stream?.registerHarnessTools === 'function'
      ? stream.registerHarnessTools.bind(stream)
      : undefined);
  if (typeof fn !== 'function') return 0;
  const before = typeof registry.list === 'function' ? registry.list!().length : undefined;
  const ret = fn(registry, ctx) as unknown;
  if (typeof ret === 'number' && Number.isFinite(ret) && ret >= 0) return Math.floor(ret);
  if (before != null && typeof registry.list === 'function') {
    return Math.max(0, registry.list().length - before);
  }
  return 0;
}

function hasDynamicToolHook(apiConfig: ApiConfig = {}, stream: LoopStream | null = null) {
  return typeof apiConfig.registerTools === 'function'
    || typeof stream?.registerHarnessTools === 'function';
}

function toolSurfaceFingerprint(workflows: string[], clientTools: unknown) {
  const w = Array.isArray(workflows) ? [...workflows].map(String).sort() : [];
  const c: string[] = [];
  if (Array.isArray(clientTools)) {
    for (const t of clientTools) {
      const tool = t as OpenAiFunctionTool;
      const n = tool?.function?.name || tool?.name;
      if (n) c.push(String(n));
    }
    c.sort();
  }
  return JSON.stringify({ w, c });
}

const MAX_TOOL_SURFACES = 32;
const toolSurfaceBySession = new Map<string, ToolSurfaceEntry>();
const toolSurfaceOrder: string[] = [];

function touchToolSurface(sessionId: string) {
  const i = toolSurfaceOrder.indexOf(sessionId);
  if (i >= 0) toolSurfaceOrder.splice(i, 1);
  toolSurfaceOrder.push(sessionId);
  while (toolSurfaceOrder.length > MAX_TOOL_SURFACES) {
    const old = toolSurfaceOrder.shift();
    if (old) toolSurfaceBySession.delete(old);
  }
}

/** Test helper — clear tool registry/pipeline cache. */
export function resetHarnessToolSurfaceCacheForTests() {
  toolSurfaceBySession.clear();
  toolSurfaceOrder.length = 0;
}

/**
 * Reuse ToolRegistry + Pipeline per session when workflow/client tool set is unchanged.
 * Dynamic registerTools hooks skip cache (rebuild every turn).
 */
function acquireToolSurface({
  harness,
  sessionId,
  workflows,
  clientTools,
  createToolRegistry,
  createToolPipeline,
  config,
  apiConfig,
  stream,
  hookCtx,
}: {
  harness: HarnessSdk
  sessionId: string
  workflows: string[]
  clientTools: unknown
  createToolRegistry: HarnessSdk['createToolRegistry']
  createToolPipeline: HarnessSdk['createToolPipeline']
  config: LlmConfig
  apiConfig: ApiConfig
  stream: LoopStream
  hookCtx: RegisterToolsHookCtx
}) {
  const dynamic = hasDynamicToolHook(apiConfig, stream);
  const fp = dynamic ? null : toolSurfaceFingerprint(workflows, clientTools);
  if (fp) {
    const hit = toolSurfaceBySession.get(sessionId);
    if (hit && hit.fp === fp) {
      touchToolSurface(sessionId);
      return {
        tools: hit.tools,
        pipeline: hit.pipeline,
        mcpCount: hit.mcpCount,
        clientCount: hit.clientCount,
        hookCount: hit.hookCount,
        cached: true,
      };
    }
  }

  const tools = createToolRegistry();
  const mcpCount = registerMcpTools(workflows, tools);
  const clientCount = registerClientOpenAiTools(tools, clientTools);
  const hookCount = invokeRegisterToolsHook(tools, hookCtx);
  const pipeline = createToolPipeline();
  pipeline.setApprovalHandler(async () => ({ approved: true }));
  attachPipelinePolicy(harness, pipeline, config, apiConfig);

  if (fp) {
    toolSurfaceBySession.set(sessionId, {
      fp,
      tools,
      pipeline,
      mcpCount,
      clientCount,
      hookCount,
    });
    touchToolSurface(sessionId);
  }

  return {
    tools,
    pipeline,
    mcpCount,
    clientCount,
    hookCount,
    cached: false,
  };
}

function resolveMaxSteps(config: LlmConfig = {}, apiConfig: ApiConfig = {}, toolCount = 0) {
  const raw = config.maxToolRounds ?? apiConfig.maxToolRounds;
  const n = Number(raw);
  const configured = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 7;
  // No tools → single LLM step (avoid empty multi-step budget).
  if (toolCount <= 0) return 1;
  return configured;
}

/** @internal tests */
export function __resolveMaxStepsForTests(config: LlmConfig, apiConfig: ApiConfig, toolCount: number) {
  return resolveMaxSteps(config, apiConfig, toolCount);
}

/** @internal tests */
export function __harnessToolSurfaceCacheSizeForTests() {
  return toolSurfaceBySession.size;
}

/**
 * Wire denylist + optional apiConfig hooks onto ToolPipeline.
 *
 * Keep `createPolicyToolCallGuard` (SDK already = denyToolNames → PolicyEngine → Guard).
 * Do **not** swap denylist to `createPolicyToolPre`: Pre is for `ask` + approval;
 * with IM `setApprovalHandler(() => approved)` that would turn denylist into auto-allow.
 */
export function attachPipelinePolicy(harness: HarnessSdk, pipeline: ToolPipelineLike, config: LlmConfig = {}, apiConfig: ApiConfig = {}) {
  const denyNames = resolveDenyToolNames(config, apiConfig);
  if (denyNames?.length) {
    pipeline.onGuard(harness.createPolicyToolCallGuard(denyNames));
  }
  const onGuard = apiConfig.onGuard ?? config.onGuard;
  if (typeof onGuard === 'function') {
    pipeline.onGuard(onGuard as (ctx: unknown) => unknown);
  }
  const onPre = apiConfig.onPre ?? config.onPre;
  if (typeof onPre === 'function') {
    pipeline.onPre(onPre as (ctx: unknown) => unknown);
  }
}

/** Sum provider usage samples from session assistant/message events. */
export function foldUsageFromEvents(events: readonly SessionEvent[] | null | undefined) {
  let prompt = 0;
  let completion = 0;
  let seen = false;
  for (const ev of events || []) {
    const evRec = ev as SessionEvent & { usage?: Record<string, unknown> };
    const u = evRec?.type === 'assistant/message' ? evRec.usage : evRec?.usage;
    if (!u || typeof u !== 'object') continue;
    const p = Number(u.inputTokens ?? u.prompt_tokens ?? u.promptTokens ?? 0);
    const c = Number(u.outputTokens ?? u.completion_tokens ?? u.completionTokens ?? 0);
    if (!Number.isFinite(p) && !Number.isFinite(c)) continue;
    seen = true;
    if (Number.isFinite(p)) prompt += Math.max(0, p);
    if (Number.isFinite(c)) completion += Math.max(0, c);
  }
  if (!seen) return undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/** Last turn tool/call + tool/result → OpenAI-style mcp_tools (args + result). */
export function foldMcpToolsFromEvents(events: unknown): FoldedMcpTool[] {
  const list = Array.isArray(events) ? events as SessionEvent[] : [];
  let lastTurnId: string | null = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const ev = list[i];
    if (ev?.type === 'turn/start' && ev.turnId) {
      lastTurnId = ev.turnId;
      break;
    }
    if (ev?.type === 'tool/call' && ev.turnId) {
      lastTurnId = ev.turnId;
      break;
    }
  }
  const byId = new Map<string, FoldedMcpTool>();
  for (const ev of list) {
    const evRec = ev as SessionEvent & {
      turnId?: string
      call?: HarnessToolCall
      result?: { toolCallId?: string; name?: string; content?: unknown; isError?: boolean }
    };
    if (lastTurnId && evRec?.turnId && evRec.turnId !== lastTurnId) continue;
    if (evRec?.type === 'tool/call' && evRec.call) {
      byId.set(evRec.call.id, {
        id: evRec.call.id,
        name: evRec.call.name,
        arguments: evRec.call.arguments ?? {},
      });
    } else if (evRec?.type === 'tool/result' && evRec.result) {
      const id = String(evRec.result.toolCallId ?? '');
      const prev = byId.get(id) || { id, name: evRec.result.name };
      byId.set(id, {
        ...prev,
        name: prev.name || evRec.result.name,
        result: evRec.result.content,
        ...(evRec.result.isError ? { isError: true } : {}),
      });
    }
  }
  return [...byId.values()];
}

/**
 * OpenAI body.tools -> registry (schema only). Execute returns error -
 * server-side MCP tools take precedence on name clash.
 */
function registerClientOpenAiTools(registry: ToolRegistryLike, tools: unknown) {
  if (!Array.isArray(tools) || !tools.length) return 0;
  let n = 0;
  for (const tRaw of tools) {
    const t = tRaw as OpenAiFunctionTool;
    const name = t?.function?.name || t?.name;
    if (!name) continue;
    if (typeof registry.get === 'function' && registry.get(name)) continue;
    if (typeof registry.has === 'function' && registry.has(name)) continue;
    const description = t.function?.description || t.description || '';
    const parameters = t.function?.parameters || t.parameters || { type: 'object', properties: {} };
    try {
      registry.register({
        name,
        description,
        parameters,
        async execute() {
          return {
            content: `Error: client tool "${name}" is not executed server-side; use MCP workflows or run tools on the client.`,
            isError: true,
          };
        },
      });
      n += 1;
    } catch {
      /* duplicate name */
    }
  }
  return n;
}

/**
 * @param {object} opts
 * @param {object} opts.stream - AiWorkflow instance
 * @param {Array} opts.messages - outbound messages
 * @param {object} opts.config - resolved LLM config
 * @param {object} [opts.apiConfig]
 * @returns {Promise<{ content: string, executedToolNames: string[], usedReplyTool?: boolean, toolRoundsExhausted?: boolean, compacted?: boolean, usage?: object, sessionId?: string, steps?: number, safetyLimited?: boolean }>}
 */
export async function runHarnessModuleLoop({ stream, messages, config, apiConfig = {} }: RunHarnessModuleLoopOptions) {
  const harness = (await importHarnessSdk()) as unknown as HarnessSdk;
  const {
    createAgent,
    createToolRegistry,
    createToolPipeline,
  } = harness;

  const conversationKey = apiConfig.sessionKey
    ?? config.sessionKey
    ?? apiConfig.conversationId
    ?? config.conversationId
    ?? null;
  const { store, sessionId, reused } = acquireHarnessSession(
    harness as unknown as Parameters<typeof acquireHarnessSession>[0],
    conversationKey,
  );

  // Reused session: prior turns live in store — do not re-split/seed OpenAI history.
  const effectiveMessages = reused ? slimMessagesForExistingSession(messages) : messages;
  const { system, history, userText, userRawContent } = splitOutboundMessages(effectiveMessages);
  const userTurn = await buildHarnessUserTurn(harness, userRawContent ?? userText);
  if (!String(userTurn.text || '').trim() && !userTurn.hasImage) {
    throw Object.assign(new Error('empty LLM response'), { code: 'empty_turn' });
  }

  if (!reused) {
    seedSessionFromHistory(store as SessionStore, sessionId, history);
  }

  const onSessionEvent = apiConfig.onSessionEvent ?? config.onSessionEvent;
  const detachListener = attachHarnessSessionListener(store, onSessionEvent as (out: unknown, sessionId: string) => void);

  try {
    const workflows: string[] = apiConfig.workflows
      ?? config.workflows
      ?? (typeof stream._getToolWorkflowNames === 'function' ? stream._getToolWorkflowNames() : []);
    const clientTools = apiConfig.tools ?? config.tools;
    const hookCtx = { harness, stream, config, apiConfig, workflows, sessionId };
    const {
      tools,
      pipeline,
      mcpCount,
      clientCount,
      hookCount,
      cached: toolsCached,
    } = acquireToolSurface({
      harness,
      sessionId,
      workflows,
      clientTools,
      createToolRegistry,
      createToolPipeline,
      config,
      apiConfig,
      stream,
      hookCtx,
    });
    const toolCount = mcpCount + clientCount + hookCount;

    const llm = createLlmFromConfig(harness, config, {
      ...(userTurn.hasImage ? { inputModalities: ['text', 'image'] } : {}),
    });
    const mapped = resolveCreateAgentMappedOptions({
      stream,
      config,
      apiConfig,
      toolCount,
      resolveImage: userTurn.resolveImage,
    });
    const signal = resolveAbortSignal(config, apiConfig);
    const maxSteps = mapped.maxSteps ?? 1;

    RuntimeUtil.makeLog(
      'info',
      `[harness-loop] session=${sessionId} reused=${reused ? 1 : 0} tools=${toolCount}`
        + ` (mcp=${mcpCount}, client=${clientCount}, hook=${hookCount}${toolsCached ? ', cached' : ''})`
        + ` workflows=[${(workflows || []).join(',')}]`
        + ` maxSteps=${maxSteps}`
        + (userTurn.hasImage ? ' vision=1' : '')
        + (mapped.compaction && typeof mapped.compaction === 'object'
          ? ` compactBudget≈${(mapped.compaction as CompactionOptionsLike).maxRequestTokens}`
          : '')
        + (mapped.llmRetry === false
          ? ' llmRetry=off'
          : (mapped.llmRetry ? ` llmRetry=${(mapped.llmRetry as LlmRetryOptionsLike).maxRetries ?? '*'}` : ''))
        + (mapped.toolSettle ? ` toolSettle=${mapped.toolSettle}` : '')
        + (mapped.safety === false ? ' safety=off' : '')
        + (mapped.jobs ? ' jobs=1' : '')
        + (onSessionEvent ? ' live=1' : ''),
      'AiWorkflow',
    );

    const agent = createAgent({
      sessionId,
      store: store as SessionStore,
      llm,
      tools: tools as unknown as CreateAgentOptions['tools'],
      pipeline: pipeline as unknown as CreateAgentOptions['pipeline'],
      ...(system ? { system } : {}),
      ...mapped,
    } as CreateAgentOptions);

    let result;
    let safetyLimited = false;
    try {
      result = await agent.continueTurn({
        text: String(userTurn.text || (userTurn.hasImage ? '\u200b' : '')),
        ...(userTurn.hasImage ? { userContent: userTurn.userContent } : {}),
        ...(signal ? { signal } : {}),
      } as ContinueTurnInput);
    } catch (err: unknown) {
      const mappedErr = mapHarnessContinueTurnError(err, harness);
      if (mappedErr.action === 'safetyLimited') {
        safetyLimited = true;
        RuntimeUtil.makeLog(
          'warn',
          `[harness-loop] session safety limit: ${mappedErr.message}`,
          'AiWorkflow',
        );
        result = { text: '', steps: 0, turnId: '' };
      } else if (mappedErr.action === 'throw') {
        throw Object.assign(new Error(mappedErr.message), {
          code: mappedErr.code,
          cause: mappedErr.cause,
        });
      } else {
        throw mappedErr.cause;
      }
    }

    {
      const dangling = harness.listDanglingToolCalls(store.get(sessionId).events) || [];
      if (dangling.length) {
        const names = dangling.map((d) => d?.call?.name || d?.call?.id || '?').join(',');
        RuntimeUtil.makeLog(
          'warn',
          `[harness-loop] dangling tools before settle: n=${dangling.length} [${names}]`,
          'AiWorkflow',
        );
      }
    }
    harness.settleDanglingTools(store as SessionStore, sessionId);
    try {
      harness.assertToolCallsSettled(store.get(sessionId).events);
    } catch (err: unknown) {
      RuntimeUtil.makeLog(
        'warn',
        `[harness-loop] assertToolCallsSettled: ${normalizeError(err).message || String(err)}`,
        'AiWorkflow',
      );
    }

    const events = store.get(sessionId).events || [];
    const mcpTools = foldMcpToolsFromEvents(events);
    const executedToolNames: string[] = [];
    let compacted = false;
    for (const tool of mcpTools) {
      if (tool?.name && !executedToolNames.includes(tool.name)) executedToolNames.push(tool.name);
    }
    for (const ev of events) {
      if (ev?.type === 'context/compaction') compacted = true;
    }
    const usedReplyTool = executedToolNames.some((n) => String(n).endsWith('.reply') || n === 'reply');
    let content = result?.text != null ? String(result.text) : '';
    if (!content.trim()) {
      const msgs = harness.deriveMessages(events);
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i]?.role === 'assistant' && String(msgs[i].content || '').trim()) {
          content = String(msgs[i].content);
          break;
        }
      }
    }
    const steps = result?.steps ?? 0;
    const toolRoundsExhausted = steps >= maxSteps && !content.trim() && executedToolNames.length > 0;
    const usage = foldUsageFromEvents(events);

    return {
      content,
      executedToolNames,
      mcpTools,
      usedReplyTool,
      sessionId,
      steps,
      reused,
      ...(compacted ? { compacted: true } : {}),
      ...(toolRoundsExhausted ? { toolRoundsExhausted: true } : {}),
      ...(safetyLimited ? { safetyLimited: true } : {}),
      ...(usage ? { usage } : {}),
    };
  } finally {
    detachListener();
  }
}
