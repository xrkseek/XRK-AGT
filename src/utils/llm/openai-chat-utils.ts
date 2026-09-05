import { pickFirstKey } from '#utils/coerce-pick.js';

/**
 * OpenAI-like Chat Completions 参数归一化工具
 */

function pick(overrides: any, config: any, keys: string[]): unknown {
  return pickFirstKey(overrides, keys) ?? pickFirstKey(config, keys);
}

export { pick };

/** OpenAI Chat Completions 兼容端点拼接（openai_compat / newapi / cherryin 等共用） */
export function buildOpenAICompatEndpoint(
  config: any,
  { defaultPath = '/chat/completions', label = 'openai_compat' }: { defaultPath?: string; label?: string } = {},
): string {
  const base = (config.baseUrl ?? '').replace(/\/+$/, '');
  const pathPart = (config.path || defaultPath).replace(/^\/?/, '/');
  if (!base) throw new Error(`${label}: 未配置 baseUrl`);
  return `${base}${pathPart}`;
}

function applyOptionalFields(body: any, overrides: any, config: any, mapping: Array<{ to: string; from: string[] }>): void {
  for (const item of mapping) {
    const v = pick(overrides, config, item.from);
    if (v !== undefined) body[item.to] = v;
  }
}

export function buildOpenAIChatCompletionsBody(
  messages: any,
  config: any = {},
  overrides: any = {},
  defaultModel?: string,
): any {
  const temperature = pick(overrides, config, ['temperature']);
  const maxCompletionTokensExplicit = pick(overrides, config, ['maxCompletionTokens', 'max_completion_tokens']);
  const maxTokensCompat = pick(overrides, config, ['maxTokens', 'max_tokens']);
  const maxCompletionTokens = maxCompletionTokensExplicit ?? maxTokensCompat;
  const tokenField = pick(overrides, config, ['tokenField', 'token_field']);

  const body: any = {
    model: pick(overrides, config, ['model', 'chatModel']) || defaultModel,
    messages,
    stream: pick(overrides, config, ['stream']) ?? false,
  };

  // 仅在调用方或配置显式设置时才下发 temperature，未配置时完全交由上游默认
  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  if (maxCompletionTokens !== undefined) {
    const want = (tokenField || '').toString().trim().toLowerCase();
    const useBoth = want === 'both';
    const useMaxCompletionTokens =
      want === 'max_completion_tokens' ||
      // 未显式指定 tokenField 时：若调用方显式传了 max_completion_tokens，则优先走该字段
      (!want && maxCompletionTokensExplicit !== undefined);

    if (useBoth) {
      body.max_completion_tokens = maxCompletionTokens;
      body.max_tokens = maxCompletionTokens;
    } else if (useMaxCompletionTokens) {
      body.max_completion_tokens = maxCompletionTokens;
    } else {
      // 默认仅发送 max_tokens，避免部分上游（如火山引擎）对两个字段互斥报错
      body.max_tokens = maxCompletionTokens;
    }
  }

  applyOptionalFields(body, overrides, config, [
    { to: 'top_p', from: ['topP', 'top_p'] },
    { to: 'presence_penalty', from: ['presencePenalty', 'presence_penalty'] },
    { to: 'frequency_penalty', from: ['frequencyPenalty', 'frequency_penalty'] },
    { to: 'stop', from: ['stop'] },
    { to: 'response_format', from: ['response_format', 'responseFormat'] },
    { to: 'stream_options', from: ['stream_options', 'streamOptions'] },
    { to: 'seed', from: ['seed'] },
    { to: 'n', from: ['n'] },
    { to: 'logit_bias', from: ['logit_bias', 'logitBias'] },
    { to: 'logprobs', from: ['logprobs'] },
    { to: 'top_logprobs', from: ['top_logprobs', 'topLogprobs'] },
    { to: 'service_tier', from: ['service_tier', 'serviceTier'] },
    { to: 'prompt_cache_key', from: ['prompt_cache_key', 'promptCacheKey'] },
    { to: 'prompt_cache_retention', from: ['prompt_cache_retention', 'promptCacheRetention'] },
    { to: 'safety_identifier', from: ['safety_identifier', 'safetyIdentifier'] },
    { to: 'reasoning_effort', from: ['reasoning_effort', 'reasoningEffort'] },
    { to: 'store', from: ['store'] },
    { to: 'verbosity', from: ['verbosity'] },
    { to: 'modalities', from: ['modalities'] },
    { to: 'prediction', from: ['prediction'] },
    { to: 'web_search_options', from: ['web_search_options', 'webSearchOptions'] },
    { to: 'audio', from: ['audio'] },
  ]);

  const userAlias = pick(overrides, config, ['prompt_cache_key', 'promptCacheKey', 'user']);
  if (userAlias !== undefined && body.prompt_cache_key === undefined) {
    body.prompt_cache_key = userAlias;
  }

  const extraBody = pick(overrides, config, ['extraBody']);
  if (config.extraBody && typeof config.extraBody === 'object') Object.assign(body, config.extraBody);
  if (extraBody && typeof extraBody === 'object') Object.assign(body, extraBody);

  if (typeof body.response_format === 'string' && body.response_format.trim()) {
    body.response_format = { type: body.response_format.trim() };
  }

  return body;
}

/**
 * 工厂路径仅透传请求体 tools（MCP schema/执行由 harness-module-loop）。
 */
export function applyOpenAITools(body: any, config: any = {}, overrides: any = {}): any {
  if (!Object.prototype.hasOwnProperty.call(overrides, 'tools')) return body;
  const requestTools = overrides.tools;
  if (!requestTools) return body;

  body.tools = requestTools;
  if (overrides.tool_choice !== undefined) body.tool_choice = overrides.tool_choice;
  else if (config.toolChoice !== undefined || config.tool_choice !== undefined) {
    body.tool_choice = config.toolChoice ?? config.tool_choice;
  }
  const parallel = pick(overrides, config, ['parallelToolCalls', 'parallel_tool_calls']);
  if (parallel !== undefined) body.parallel_tool_calls = parallel;
  else if (overrides.parallel_tool_calls !== undefined) {
    body.parallel_tool_calls = overrides.parallel_tool_calls;
  }
  return body;
}
