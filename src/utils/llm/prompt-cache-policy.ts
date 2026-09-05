// @ts-nocheck
import RuntimeUtil from '#utils/runtime-util.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { pickTrimmed } from '#utils/coerce-pick.js';

/**
 * LLM Provider 提示缓存（OpenAI prompt_cache_key / Anthropic cache_control）。
 * 静态前缀在前、动态后缀在后；与 stream-cache（整轮结果 LRU）无关。
 */

/**
 * @param {{ keyPrefix?: string, streamName?: string, model?: string, selfId?: string|number, scopeId?: string|number, scopeInKey?: boolean }} parts
 */
export function buildPromptCacheKey(parts = {}) {
  const segments = [
    pickTrimmed(parts.keyPrefix, 'xrk'),
    pickTrimmed(parts.streamName, 'stream'),
    pickTrimmed(parts.model, 'default'),
  ];
  if (parts.scopeInKey !== false && parts.selfId != null) {
    segments.push(String(parts.selfId));
  }
  if (parts.scopeInKey !== false && parts.scopeId != null && String(parts.scopeId) !== '') {
    segments.push(String(parts.scopeId));
  }
  return segments.filter(Boolean).join(':');
}

function getGlobalPromptCacheCfg() {
  return getAiWorkflowConfigOptional().llm?.promptCache ?? {};
}

export function isPromptCacheEnabled(resolvedConfig = {}) {
  const pc = resolvedConfig.promptCache ?? getGlobalPromptCacheCfg();
  return pc.enabled === true;
}

/**
 * @param {object} resolvedConfig
 * @param {{ stream?: object, e?: object|null }} ctx
 */
export function applyPromptCachePolicy(resolvedConfig = {}, ctx = {}) {
  if (!isPromptCacheEnabled(resolvedConfig)) return resolvedConfig;

  const pc = resolvedConfig.promptCache ?? getGlobalPromptCacheCfg();
  const out = { ...resolvedConfig };
  const e = ctx.e;
  const scopeInKey = pc.scopeInKey !== false;

  if (!pickTrimmed(out.prompt_cache_key, out.promptCacheKey)) {
    const key = buildPromptCacheKey({
      keyPrefix: pc.keyPrefix,
      streamName: ctx.stream?.name,
      model: out.model ?? out.chatModel,
      selfId: e?.self_id,
      scopeId: e?.group_id ?? e?.user_id ?? e?.device_id ?? '',
      scopeInKey,
    });
    out.prompt_cache_key = key;
    out.promptCacheKey = key;
  }

  const retention = pickTrimmed(out.prompt_cache_retention, out.promptCacheRetention, pc.retention);
  if (retention) {
    out.prompt_cache_retention = retention;
    out.promptCacheRetention = retention;
  }

  if (pc.anthropicCache !== false) {
    out.anthropic_prompt_cache = true;
  }

  return out;
}

export function logPromptCacheUsage(usage, label = 'LLM') {
  if (!usage || typeof usage !== 'object') return;

  const cached =
    usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_token_details?.cache_read_input_tokens
    ?? usage.cache_read_input_tokens;

  if (cached == null || Number(cached) <= 0) return;

  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? '-';
  RuntimeUtil.makeLog(
    'debug',
    `[PromptCache] ${label} cached_tokens=${cached} prompt_tokens=${promptTokens}`,
    'PromptCache'
  );
}

/** 从 LLM 配置提取应传入 client.chat 的 cache 覆盖项 */
export function pickPromptCacheOverrides(resolvedConfig = {}, ctx = {}) {
  const merged = applyPromptCachePolicy(resolvedConfig, ctx);
  const out = {};
  if (merged.prompt_cache_key) out.prompt_cache_key = merged.prompt_cache_key;
  if (merged.prompt_cache_retention) out.prompt_cache_retention = merged.prompt_cache_retention;
  if (merged.anthropic_prompt_cache) out.anthropic_prompt_cache = merged.anthropic_prompt_cache;
  return out;
}
