import RuntimeUtil from '#utils/runtime-util.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { pickTrimmed } from '#utils/coerce-pick.js';

/**
 * LLM Provider 提示缓存（OpenAI prompt_cache_key / Anthropic cache_control）。
 * 静态前缀在前、动态后缀在后；与 stream-cache（整轮结果 LRU）无关。
 */

type PromptCacheConfig = Record<string, unknown> & {
  enabled?: boolean;
  scopeInKey?: boolean;
  keyPrefix?: string;
  retention?: string;
  anthropicCache?: boolean;
};

type ResolvedLlmConfig = Record<string, unknown> & {
  promptCache?: PromptCacheConfig;
  prompt_cache_key?: string;
  promptCacheKey?: string;
  prompt_cache_retention?: string;
  promptCacheRetention?: string;
  anthropic_prompt_cache?: boolean;
  model?: string;
  chatModel?: string;
};

type PromptCacheCtx = {
  e?: {
    self_id?: string | number;
    group_id?: string | number;
    user_id?: string | number;
    device_id?: string | number;
  };
  stream?: { name?: string };
};

type UsageStats = Record<string, unknown> & {
  prompt_tokens_details?: { cached_tokens?: number };
  input_token_details?: { cache_read_input_tokens?: number };
  cache_read_input_tokens?: number;
  prompt_tokens?: number;
  input_tokens?: number;
};

export function buildPromptCacheKey(
  parts: {
    keyPrefix?: string;
    streamName?: string;
    model?: string;
    selfId?: string | number;
    scopeId?: string | number;
    scopeInKey?: boolean;
  } = {},
): string {
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

function getGlobalPromptCacheCfg(): PromptCacheConfig {
  const llm = getAiWorkflowConfigOptional().llm as { promptCache?: PromptCacheConfig } | undefined;
  return llm?.promptCache ?? {};
}

export function isPromptCacheEnabled(resolvedConfig: ResolvedLlmConfig = {}): boolean {
  const pc = resolvedConfig.promptCache ?? getGlobalPromptCacheCfg();
  return pc.enabled === true;
}

export function applyPromptCachePolicy(
  resolvedConfig: ResolvedLlmConfig = {},
  ctx: PromptCacheCtx = {},
): ResolvedLlmConfig {
  if (!isPromptCacheEnabled(resolvedConfig)) return resolvedConfig;

  const pc = resolvedConfig.promptCache ?? getGlobalPromptCacheCfg();
  const out: ResolvedLlmConfig = { ...resolvedConfig };
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

export function logPromptCacheUsage(usage: any, label = 'LLM'): void {
  if (!usage || typeof usage !== 'object') return;

  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_token_details?.cache_read_input_tokens ??
    usage.cache_read_input_tokens;

  if (cached == null || Number(cached) <= 0) return;

  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? '-';
  RuntimeUtil.makeLog(
    'debug',
    `[PromptCache] ${label} cached_tokens=${cached} prompt_tokens=${promptTokens}`,
    'PromptCache',
  );
}

/** 从 LLM 配置提取应传入 client.chat 的 cache 覆盖项 */
export function pickPromptCacheOverrides(
  resolvedConfig: ResolvedLlmConfig = {},
  ctx: PromptCacheCtx = {},
): Record<string, unknown> {
  const merged = applyPromptCachePolicy(resolvedConfig, ctx);
  const out: Record<string, unknown> = {};
  if (merged.prompt_cache_key) out.prompt_cache_key = merged.prompt_cache_key;
  if (merged.prompt_cache_retention) out.prompt_cache_retention = merged.prompt_cache_retention;
  if (merged.anthropic_prompt_cache) out.anthropic_prompt_cache = merged.anthropic_prompt_cache;
  return out;
}
