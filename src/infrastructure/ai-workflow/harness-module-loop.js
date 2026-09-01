/**
 * Embed @xrkseek/harness agent loop for AiWorkflow.callAI and /v1+MCP workflows.
 * AGT keeps chat.js / MCPServer; harness owns continueTurn, compaction, retries, adapters.
 */
import RuntimeUtil from '#utils/runtime-util.js';
import { MCPToolAdapter } from '#utils/llm/mcp-tool-adapter.js';
import { resolveInputTokenBudget } from '#utils/llm/message-token-budget.js';
import { parseToolCallArguments } from '#utils/llm/parse-tool-arguments.js';
import { importHarnessSdk } from './harness-resolve.js';
import {
  acquireHarnessSession,
  attachHarnessSessionListener,
} from './harness-session-registry.js';

function flattenContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text') return p.text || '';
      return '';
    }).join('');
  }
  if (typeof content === 'object' && content.text != null) return String(content.text);
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * OpenAI multimodal parts -> harness MessageContent + resolveImage (SDK attachment store).
 * Text-only stays string; data-URL images become ContentBlock image refs.
 */
export async function buildHarnessUserTurn(harness, rawContent) {
  const text = flattenContent(rawContent);
  if (!Array.isArray(rawContent)) {
    return { text, userContent: text };
  }
  const imageParts = rawContent.filter(
    (p) => p && (p.type === 'image_url' || p.type === 'image'),
  );
  if (!imageParts.length) {
    return { text, userContent: text };
  }

  const store = harness.createMemoryAttachmentStore();
  const blocks = [];
  const pending = [];

  for (const p of rawContent) {
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
    ? await store.saveImages(pending.map((x) => ({ data: x.data, mediaType: x.mediaType })))
    : [];
  const out = [];
  for (const b of blocks) {
    if (b.type === 'text') out.push(b);
    else if (b.type === 'image') {
      const ref = refs[b._pending];
      if (ref) out.push({ type: 'image', attachment: ref });
    }
  }
  const userContent = out.length ? out : text;
  const resolveImage = async (attachmentId) => {
    const stored = await store.readImage(attachmentId);
    return {
      mediaType: stored.ref.mediaType,
      data: stored.data,
      ref: stored.ref,
    };
  };
  return {
    text: text || (harness.flattenText ? harness.flattenText(userContent) : ''),
    userContent,
    resolveImage,
    hasImage: true,
  };
}


/**
 * Split AGT OpenAI-style messages -> system + prior turns + latest user.
 */
export function splitOutboundMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systems = [];
  const history = [];
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
  let userRawContent = '';
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

function parseToolArguments(raw) {
  const parsed = parseToolCallArguments(raw);
  if (parsed.ok) return parsed.args;
  return parsed.args && typeof parsed.args === 'object' ? parsed.args : { _raw: String(raw) };
}

/** OpenAI-style assistant.tool_calls -> harness ToolCall[]. */
export function extractAssistantToolCalls(message) {
  const raw = message?.tool_calls ?? message?.toolCalls;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((tc, i) => {
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
export function seedSessionFromHistory(store, sessionId, history) {
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
      });
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
      });
      if (toolCalls) {
        for (let i = 0; i < toolCalls.length; i += 1) {
          store.append(sessionId, {
            type: 'tool/call',
            ts: ts + i + 1,
            turnId,
            stepId: `seed_step_${turn}_tc_${i}`,
            call: toolCalls[i],
          });
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
      });
    }
  }
}

/** Name heuristic: read-ish MCP tools may settle in parallel. */
export function isLikelyReadOnlyTool(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (/(^|[._-])(write|create|update|delete|remove|send|reply|exec|run|put|post|patch|mutate)([._-]|$)/.test(n)) {
    return false;
  }
  return /(^|[._-])(read|get|list|search|query|find|fetch|stat|info|describe)([._-]|$)/.test(n);
}

function registerMcpTools(workflows, registry) {
  const openAiTools = MCPToolAdapter.convertMCPToolsToOpenAI({ workflows });
  for (const t of openAiTools) {
    const name = t?.function?.name;
    if (!name) continue;
    const description = t.function.description || '';
    const parameters = t.function.parameters || { type: 'object', properties: {} };
    const readOnly = isLikelyReadOnlyTool(name);
    const concludes = String(name).endsWith('.reply') || name === 'reply';
    registry.register({
      name,
      description,
      parameters,
      ...(readOnly ? { isConcurrencySafe: () => true } : {}),
      async execute(args) {
        const rawArgs = typeof args === 'string' ? args : JSON.stringify(args ?? {});
        const rows = await MCPToolAdapter.handleToolCalls(
          [{
            id: `call_${Date.now().toString(36)}`,
            type: 'function',
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
export function mapHarnessReasoningEffort(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === 'disabled') return 'off';
  if (v === 'low' || v === 'minimal') return 'low';
  if (v === 'max') return 'max';
  if (v === 'high' || v === 'medium' || v === 'xhigh') return 'high';
  return undefined;
}

function resolveDeepSeekThinkingDefaults(config = {}) {
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
export function withRouteReasoning(llm, reasoningEffort, model) {
  if (!reasoningEffort || !llm) return llm;
  const basePeek = typeof llm.peekRoute === 'function' ? () => llm.peekRoute() : () => undefined;
  const baseEnsure = typeof llm.ensureRoute === 'function'
    ? () => llm.ensureRoute()
    : () => ({ provider: llm.id || 'agt', model: model || '' });
  return {
    id: llm.id,
    inputModalities: llm.inputModalities,
    chat: (req) => llm.chat(req),
    ...(typeof llm.stream === 'function' ? { stream: (req) => llm.stream(req) } : {}),
    peekRoute() {
      const prev = basePeek() || {};
      return { ...prev, reasoningEffort };
    },
    ensureRoute() {
      const prev = baseEnsure() || { provider: llm.id || 'agt', model: model || '' };
      return { ...prev, reasoningEffort };
    },
  };
}

/** parallel_tool_calls -> createAgent toolSettle / maxParallelToolCalls. */
export function resolveToolSettle(config = {}, apiConfig = {}) {
  const parallel = apiConfig.parallel_tool_calls
    ?? apiConfig.parallelToolCalls
    ?? config.parallel_tool_calls
    ?? config.parallelToolCalls;
  const maxRaw = apiConfig.maxParallelToolCalls ?? config.maxParallelToolCalls;
  const max = Number(maxRaw);
  const out = {};
  if (parallel === false) out.toolSettle = 'serial';
  else if (parallel === true) out.toolSettle = 'parallel';
  if (Number.isFinite(max) && max > 0) {
    out.toolSettle = out.toolSettle || 'parallel';
    out.maxParallelToolCalls = Math.floor(max);
  }
  return out;
}

/** Map AGT provider config -> harness native adapter when possible. */
export function createLlmFromConfig(harness, config, options = {}) {
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

/** Provider contextWindow -> harness CompactionOptions (soft budget + auto summary). */
export function resolveHarnessCompaction(config = {}) {
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

export function resolveHarnessLlmRetry(config = {}, apiConfig = {}) {
  const retry = apiConfig.retry ?? config.retry;
  if (retry === false || retry?.enabled === false) return false;
  if (!retry || typeof retry !== 'object') return undefined;

  const out = {};
  // AGT maxAttempts = total tries including first; SDK maxRetries = retries after failure.
  if (retry.maxRetries != null) {
    const n = Number(retry.maxRetries);
    if (Number.isFinite(n) && n >= 0) out.maxRetries = Math.floor(n);
  } else {
    const attempts = Number(retry.maxAttempts ?? retry.attempts);
    if (Number.isFinite(attempts) && attempts >= 1) {
      out.maxRetries = Math.max(0, Math.floor(attempts) - 1);
    }
  }

  const delay = Number(retry.delay ?? retry.initialDelayMs);
  if (Number.isFinite(delay) && delay > 0) out.initialDelayMs = Math.floor(delay);

  const maxDelay = Number(retry.maxDelay ?? retry.maxDelayMs);
  if (Number.isFinite(maxDelay) && maxDelay > 0) out.maxDelayMs = Math.floor(maxDelay);

  if (Array.isArray(retry.retryableCodes) && retry.retryableCodes.length) {
    out.retryableCodes = retry.retryableCodes.map(String);
  } else if (Array.isArray(retry.retryOn) && retry.retryOn.length) {
    const codes = mapAgtRetryOnToCodes(retry.retryOn);
    if (codes) out.retryableCodes = codes;
  }

  if (retry.mode === 'always' || retry.mode === 'normal') out.mode = retry.mode;

  return Object.keys(out).length ? out : undefined;
}

/** AGT yaml retryOn -> harness retryableCodes. */
function mapAgtRetryOnToCodes(retryOn) {
  const set = new Set();
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
export function resolveHarnessSafety(config = {}, apiConfig = {}) {
  const raw = apiConfig.safety
    ?? apiConfig.harnessSafety
    ?? config.safety
    ?? config.harnessSafety;
  if (raw === false) return false;
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  if (raw.loopDetection === false) out.loopDetection = false;
  else if (raw.loopDetection && typeof raw.loopDetection === 'object') {
    out.loopDetection = raw.loopDetection;
  }
  if (raw.mistake && typeof raw.mistake === 'object') out.mistake = raw.mistake;
  return Object.keys(out).length ? out : raw;
}

/** Denylist names from apiConfig / config (policy createPolicyToolCallGuard). */
export function resolveDenyToolNames(config = {}, apiConfig = {}) {
  const raw = apiConfig.denyTools
    ?? apiConfig.denyToolNames
    ?? config.denyTools
    ?? config.denyToolNames;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const names = raw.map((n) => String(n || '').trim()).filter(Boolean);
  return names.length ? names : undefined;
}

function resolveAbortSignal(config = {}, apiConfig = {}) {
  const outer = apiConfig.signal ?? config.signal ?? undefined;
  const timeoutMs = Number(apiConfig.timeout ?? config.timeout ?? config.timeoutMs);
  const parts = [];
  if (outer) parts.push(outer);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal.timeout === 'function') {
    parts.push(AbortSignal.timeout(Math.floor(timeoutMs)));
  }
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(parts);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  for (const s of parts) {
    if (s.aborted) {
      ac.abort();
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return ac.signal;
}

function resolveTurnHooks(stream, config = {}, apiConfig = {}) {
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

function isHarnessSafetyLimitError(err, harness) {
  if (!err) return false;
  if (err.name === 'SessionSafetyLimitError') return true;
  if (harness?.SessionSafetyLimitError && err instanceof harness.SessionSafetyLimitError) {
    return true;
  }
  return false;
}

function isHarnessBusyError(err, harness) {
  if (!err) return false;
  if (err.name === 'SessionBusyError') return true;
  if (harness?.SessionBusyError && err instanceof harness.SessionBusyError) return true;
  return false;
}

/**
 * Optional extension: register extra tools after MCP / client schema tools.
 * Prefer apiConfig.registerTools(registry, ctx); stream.registerHarnessTools as fallback.
 */
function invokeRegisterToolsHook(registry, ctx) {
  const { apiConfig, stream } = ctx;
  const fn = apiConfig?.registerTools
    ?? (typeof stream?.registerHarnessTools === 'function'
      ? stream.registerHarnessTools.bind(stream)
      : undefined);
  if (typeof fn !== 'function') return 0;
  const before = typeof registry.list === 'function' ? registry.list().length : undefined;
  const ret = fn(registry, ctx);
  if (Number.isFinite(ret) && ret >= 0) return Math.floor(ret);
  if (before != null && typeof registry.list === 'function') {
    return Math.max(0, registry.list().length - before);
  }
  return 0;
}

function attachPipelinePolicy(harness, pipeline, config, apiConfig) {
  const denyNames = resolveDenyToolNames(config, apiConfig);
  if (denyNames?.length) {
    pipeline.onGuard(harness.createPolicyToolCallGuard(denyNames));
  }
  const onGuard = apiConfig.onGuard ?? config.onGuard;
  if (typeof onGuard === 'function') {
    pipeline.onGuard(onGuard);
  }
  const onPre = apiConfig.onPre ?? config.onPre;
  if (typeof onPre === 'function') {
    pipeline.onPre(onPre);
  }
}

/** Sum provider usage samples from session assistant/message events. */
export function foldUsageFromEvents(events) {
  let prompt = 0;
  let completion = 0;
  let seen = false;
  for (const ev of events || []) {
    const u = ev?.type === 'assistant/message' ? ev.usage : ev?.usage;
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
export function foldMcpToolsFromEvents(events) {
  const list = Array.isArray(events) ? events : [];
  let lastTurnId = null;
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
  const byId = new Map();
  for (const ev of list) {
    if (lastTurnId && ev?.turnId && ev.turnId !== lastTurnId) continue;
    if (ev?.type === 'tool/call' && ev.call) {
      byId.set(ev.call.id, {
        id: ev.call.id,
        name: ev.call.name,
        arguments: ev.call.arguments ?? {},
      });
    } else if (ev?.type === 'tool/result' && ev.result) {
      const id = ev.result.toolCallId;
      const prev = byId.get(id) || { id, name: ev.result.name };
      byId.set(id, {
        ...prev,
        name: prev.name || ev.result.name,
        result: ev.result.content,
        ...(ev.result.isError ? { isError: true } : {}),
      });
    }
  }
  return [...byId.values()];
}

/**
 * OpenAI body.tools -> registry (schema only). Execute returns error -
 * server-side MCP tools take precedence on name clash.
 */
function registerClientOpenAiTools(registry, tools) {
  if (!Array.isArray(tools) || !tools.length) return 0;
  let n = 0;
  for (const t of tools) {
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
export async function runHarnessModuleLoop({ stream, messages, config, apiConfig = {} }) {
  const harness = await importHarnessSdk();
  const {
    createAgent,
    createToolRegistry,
    createToolPipeline,
  } = harness;

  const { system, history, userText, userRawContent } = splitOutboundMessages(messages);
  const userTurn = await buildHarnessUserTurn(harness, userRawContent ?? userText);
  if (!String(userTurn.text || '').trim() && !userTurn.hasImage) {
    throw Object.assign(new Error('empty LLM response'), { code: 'empty_turn' });
  }

  const conversationKey = apiConfig.sessionKey
    ?? config.sessionKey
    ?? apiConfig.conversationId
    ?? config.conversationId
    ?? null;
  const { store, sessionId, reused } = acquireHarnessSession(harness, conversationKey);
  if (!reused) {
    seedSessionFromHistory(store, sessionId, history);
  }

  const onSessionEvent = apiConfig.onSessionEvent ?? config.onSessionEvent;
  const detachListener = attachHarnessSessionListener(store, onSessionEvent);

  try {
    const tools = createToolRegistry();
    const workflows = apiConfig.workflows
      ?? config.workflows
      ?? (typeof stream._getToolWorkflowNames === 'function' ? stream._getToolWorkflowNames() : []);
    const mcpCount = registerMcpTools(workflows, tools);
    const clientTools = apiConfig.tools ?? config.tools;
    const clientCount = registerClientOpenAiTools(tools, clientTools);
    const hookCtx = { harness, stream, config, apiConfig, workflows, sessionId };
    const hookCount = invokeRegisterToolsHook(tools, hookCtx);
    const toolCount = mcpCount + clientCount + hookCount;

    const llm = createLlmFromConfig(harness, config, {
      ...(userTurn.hasImage ? { inputModalities: ['text', 'image'] } : {}),
    });
    const maxSteps = config.maxToolRounds || apiConfig.maxToolRounds || 7;
    const compaction = resolveHarnessCompaction(config);
    const llmRetry = resolveHarnessLlmRetry(config, apiConfig);
    const toolSettle = resolveToolSettle(config, apiConfig);
    const signal = resolveAbortSignal(config, apiConfig);
    const safety = resolveHarnessSafety(config, apiConfig);
    const turnHooks = resolveTurnHooks(stream, config, apiConfig);
    const pipeline = createToolPipeline();
    pipeline.setApprovalHandler(async () => ({ approved: true }));
    attachPipelinePolicy(harness, pipeline, config, apiConfig);

    RuntimeUtil.makeLog(
      'info',
      `[harness-loop] session=${sessionId} reused=${reused ? 1 : 0} tools=${toolCount}`
        + ` (mcp=${mcpCount}, client=${clientCount}, hook=${hookCount})`
        + ` workflows=[${(workflows || []).join(',')}]`
        + ` maxSteps=${maxSteps}`
        + (userTurn.hasImage ? ' vision=1' : '')
        + (compaction ? ` compactBudget≈${compaction.maxRequestTokens}` : '')
        + (llmRetry === false ? ' llmRetry=off' : (llmRetry ? ` llmRetry=${llmRetry.maxRetries ?? '*'}` : ''))
        + (toolSettle.toolSettle ? ` toolSettle=${toolSettle.toolSettle}` : '')
        + (safety === false ? ' safety=off' : '')
        + (onSessionEvent ? ' live=1' : ''),
      'AiWorkflow',
    );

    const agent = createAgent({
      sessionId,
      store,
      llm,
      tools,
      pipeline,
      ...(system ? { system } : {}),
      maxSteps,
      ...(safety !== undefined ? { safety } : {}),
      ...(compaction ? { compaction } : {}),
      ...(llmRetry !== undefined ? { llmRetry } : {}),
      ...toolSettle,
      ...turnHooks,
      ...(userTurn.resolveImage ? { resolveImage: userTurn.resolveImage } : {}),
      toolResultMaxInlineBytes: config.toolResultMaxInlineBytes
        ?? apiConfig.toolResultMaxInlineBytes
        ?? 64 * 1024,
    });

    let result;
    let safetyLimited = false;
    try {
      result = await agent.continueTurn({
        text: String(userTurn.text || (userTurn.hasImage ? '\u200b' : '')),
        ...(userTurn.hasImage ? { userContent: userTurn.userContent } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (isHarnessSafetyLimitError(err, harness)) {
        safetyLimited = true;
        RuntimeUtil.makeLog(
          'warn',
          `[harness-loop] session safety limit: ${err.message || err.reason || 'limit'}`,
          'AiWorkflow',
        );
        result = { text: '', steps: 0 };
      } else if (isHarnessBusyError(err, harness)) {
        throw Object.assign(new Error(err.message || 'session busy'), { code: 'session_busy', cause: err });
      } else if (harness.isContextOverflowError(err) || err?.name === 'ContextOverflowError') {
        throw Object.assign(new Error(err.message || 'context overflow'), {
          code: 'context_overflow',
          cause: err,
        });
      } else if (harness.isUnsupportedContentError(err) || err?.name === 'UnsupportedContentError') {
        throw Object.assign(new Error(err.message || 'unsupported content'), {
          code: 'unsupported_content',
          cause: err,
        });
      } else {
        throw err;
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
    harness.settleDanglingTools(store, sessionId);
    try {
      harness.assertToolCallsSettled(store.get(sessionId).events);
    } catch (err) {
      RuntimeUtil.makeLog(
        'warn',
        `[harness-loop] assertToolCallsSettled: ${err?.message || err}`,
        'AiWorkflow',
      );
    }

    const events = store.get(sessionId).events || [];
    const mcpTools = foldMcpToolsFromEvents(events);
    const executedToolNames = [];
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

export default {
  splitOutboundMessages,
  extractAssistantToolCalls,
  seedSessionFromHistory,
  isLikelyReadOnlyTool,
  mapHarnessReasoningEffort,
  withRouteReasoning,
  resolveToolSettle,
  createLlmFromConfig,
  resolveHarnessCompaction,
  resolveHarnessLlmRetry,
  resolveHarnessSafety,
  resolveDenyToolNames,
  buildHarnessUserTurn,
  foldUsageFromEvents,
  foldMcpToolsFromEvents,
  runHarnessModuleLoop,
};
