import LLMFactory from '#factory/llm/LLMFactory.js';
import { estimateTokensRough } from '#utils/token-estimate.js';
import { normalizeStringArray } from '#utils/string-array-utils.js';
import { pickFirstKey } from '#utils/coerce-pick.js';

type Dict = Record<string, unknown>;

type ChatMessageLike = {
  content?: unknown;
  [key: string]: unknown;
};

type WorkflowBodyConfig = {
  workflows?: unknown;
  workflow?: unknown;
  [key: string]: unknown;
};

export function pickFirst(obj: unknown, keys: string[]): unknown {
  return pickFirstKey(obj as Dict | null | undefined, keys);
}

export function parseOptionalJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

export function toNum(v: unknown): number | undefined {
  if (v == null || v === '') return;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function toBool(v: unknown): boolean | undefined {
  if (v == null || v === '') return;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return;
}

export const trimLower = (v: unknown): string => (v || '').toString().trim().toLowerCase();

export function getDefaultProvider(): string {
  return String(LLMFactory.resolveProvider({}) ?? '');
}

export function resolveProviderFromRequest(body: Dict = {}): string {
  return String(
    LLMFactory.resolveProvider({
      model: trimLower(pickFirst(body, ['model'])),
      provider: trimLower(pickFirst(body, ['provider', 'llm', 'profile'])),
      llm: trimLower(pickFirst(body, ['llm'])),
      profile: trimLower(pickFirst(body, ['profile'])),
      defaultProvider: getDefaultProvider(),
    }) ?? '',
  );
}

export function extractMessageText(messages: ChatMessageLike[]): string {
  return messages
    .map((m) => {
      const content = m.content;
      if (typeof content === 'string') return content;
      if (content && typeof content === 'object' && 'text' in content) {
        return String((content as { text?: unknown }).text || '');
      }
      return '';
    })
    .join('');
}

export const estimateTokens = estimateTokensRough;

export function resolveWorkflowStreams(body: Dict = {}): string[] | null {
  const workflowConfig = pickFirst(body, ['workflow']) as WorkflowBodyConfig | null | undefined;
  if (!workflowConfig || typeof workflowConfig !== 'object') return null;
  const names: unknown[] = [];
  if (Array.isArray(workflowConfig.workflows)) names.push(...workflowConfig.workflows);
  if (typeof workflowConfig.workflow === 'string') names.push(workflowConfig.workflow);
  const normalized = normalizeStringArray(names);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Whether /v1 should embed @xrkseek/harness (web console + MCP workflows).
 * Client-supplied `tools` without workflows stay on factory passthrough
 * (return tool_calls to the client without server-side MCP execute).
 *
 * @see .cursor/skills/xrk-v3-api/SKILL.md — /v1 chat/completions 分流
 */
export function shouldUseHarnessModuleLoop(
  body: Dict = {},
  effectiveStreams: string[] | null | undefined = null,
): boolean {
  if (Array.isArray(effectiveStreams) && effectiveStreams.length > 0) return true;
  const tools = pickFirst(body, ['tools']);
  if (Array.isArray(tools) && tools.length > 0) return false;
  return true;
}

/**
 * OpenAI Chat `stream=true` → harness live SSE（assistant/chunk · tool/call · tool/result）。
 * Anthropic Messages / Responses 网关（`xrkGatewayFormat`）即使 stream 仍整段 JSON（非 OpenAI SSE）。
 *
 * @see docs/harness-module-loop.md — `/v1` + OpenAI stream live SSE
 */
export function shouldWantOpenAiLiveSse(
  streamFlag: boolean,
  gatewayFormat: string | null | undefined = null,
): boolean {
  return !!streamFlag
    && gatewayFormat !== 'anthropic'
    && gatewayFormat !== 'responses';
}

export function buildOverridesFromBody(body: Dict = {}): Dict {
  const overrides: Dict = {};
  const addNum = (key: string, ...aliases: string[]) => {
    const v = toNum(pickFirst(body, [key, ...aliases]));
    if (v !== undefined) {
      overrides[key] = v;
      if (aliases.length) overrides[aliases[0]!] = v;
    }
  };
  const addVal = (key: string, ...aliases: string[]) => {
    const v = pickFirst(body, [key, ...aliases]);
    if (v !== undefined) {
      overrides[key] = v;
      if (aliases.length) overrides[aliases[0]!] = v;
    }
  };
  const addBool = (key: string, ...aliases: string[]) => {
    const v = toBool(pickFirst(body, [key, ...aliases]));
    if (v !== undefined) {
      overrides[key] = v;
      if (aliases.length) overrides[aliases[0]!] = v;
    }
  };

  addNum('temperature');
  addNum('max_tokens', 'maxTokens', 'max_completion_tokens', 'maxCompletionTokens');
  addNum('top_p', 'topP');
  addNum('presence_penalty', 'presencePenalty');
  addNum('frequency_penalty', 'frequencyPenalty');
  addVal('tool_choice', 'toolChoice');
  addBool('parallel_tool_calls', 'parallelToolCalls');
  addVal('tools');
  addVal('stop');
  addVal('response_format', 'responseFormat');
  addVal('stream_options', 'streamOptions');
  addNum('seed');
  addVal('user');
  addNum('n');
  addVal('logit_bias', 'logitBias');
  addBool('logprobs');
  addNum('top_logprobs', 'topLogprobs');

  const extraBody = parseOptionalJson(pickFirst(body, ['extraBody']));
  if (extraBody && typeof extraBody === 'object') overrides.extraBody = extraBody;
  return overrides;
}
