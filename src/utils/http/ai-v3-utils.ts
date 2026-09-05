import LLMFactory from '#factory/llm/LLMFactory.js';
import { estimateTokensRough } from '#utils/token-estimate.js';
import { normalizeStringArray } from '#utils/string-array-utils.js';
import { pickFirstKey } from '#utils/coerce-pick.js';

export function pickFirst(obj: any, keys: any) {
  return pickFirstKey(obj, keys);
}

export function parseOptionalJson(raw: any) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

export function toNum(v: any) {
  if (v == null || v === '') return;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function toBool(v: any) {
  if (v == null || v === '') return;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return;
}

export const trimLower = (v: any) => (v || '').toString().trim().toLowerCase();

export function getDefaultProvider(): any {
  return LLMFactory.resolveProvider({}) ?? '';
}

export function resolveProviderFromRequest(body: any = {}) {
  return LLMFactory.resolveProvider({
    model: trimLower(pickFirst(body, ['model'])),
    provider: trimLower(pickFirst(body, ['provider', 'llm', 'profile'])),
    llm: trimLower(pickFirst(body, ['llm'])),
    profile: trimLower(pickFirst(body, ['profile'])),
    defaultProvider: getDefaultProvider()
  });
}

export function extractMessageText(messages: any) {
  return messages.map((m: any) => {
    const content = m.content;
    return typeof content === 'string' ? content : (content?.text || '');
  }).join('');
}

export const estimateTokens = estimateTokensRough;

export function resolveWorkflowStreams(body: any = {}) {
  const workflowConfig: any = pickFirst(body, ['workflow']);
  if (!workflowConfig || typeof workflowConfig !== 'object') return null;
  const names: any[] = [];
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
 * @param {object} body
 * @param {string[]|null|undefined} effectiveStreams
 * @returns {boolean}
 */
export function shouldUseHarnessModuleLoop(body: any = {}, effectiveStreams: any = null) {
  if (Array.isArray(effectiveStreams) && effectiveStreams.length > 0) return true;
  const tools = pickFirst(body, ['tools']);
  if (Array.isArray(tools) && tools.length > 0) return false;
  return true;
}

export function buildOverridesFromBody(body: any = {}) {
  const overrides: any = {};
  const addNum = (key: any, ...aliases: any[]) => {
    const v = toNum(pickFirst(body, [key, ...aliases]));
    if (v !== undefined) {
      overrides[key] = v;
      if (aliases.length) overrides[aliases[0]] = v;
    }
  };
  const addVal = (key: any, ...aliases: any[]) => {
    const v = pickFirst(body, [key, ...aliases]);
    if (v !== undefined) {
      overrides[key] = v;
      if (aliases.length) overrides[aliases[0]] = v;
    }
  };
  const addBool = (key: any, ...aliases: any[]) => {
    const v = toBool(pickFirst(body, [key, ...aliases]));
    if (v !== undefined) {
      overrides[key] = v;
      if (aliases.length) overrides[aliases[0]] = v;
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
