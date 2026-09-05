import RuntimeUtil from '#utils/runtime-util.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import LLMFactory from '#factory/llm/LLMFactory.js';
import { pickFirstDefined, pickTrimmed, pickNonEmptyUrl, shallowMergePlain } from '#utils/coerce-pick.js';
import { resolveProviderVariantPatch } from '#utils/llm/provider-variant.js';

/**
 * 工作流运行时 LLM 配置分层合并（非 request body 组装）。
 *
 * 职责边界：
 * - 此处只做 apiConfig → stream.config → providers[] → ai-workflow.llm 的字段合并
 * - 各厂商官方/兼容协议的 body、SSE、鉴权由 factory/*LLMClient 按官方文档实现
 * - 业务工作流通过 AiWorkflow.patchLLMConfig() 追加场景字段，勿在此写厂商 body 逻辑
 */

function defaultProvider() {
  return LLMFactory.resolveProvider({}) ?? LLMFactory.listProviders()[0] ?? null;
}

function assignDefined(target: any, fields: any) {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) target[key] = value;
  }
}

/**
 * @param {object} stream - AiWorkflow 实例
 * @param {object} [apiConfig={}]
 */
export function resolveStreamLLMConfig(stream: any, apiConfig: any = {}) {
  const ai = getAiWorkflowConfigOptional();
  const llm = ai.llm || {};
  const pick = pickFirstDefined;

  const providerRaw = (apiConfig.provider || stream.config?.provider || llm.Provider || llm.provider || '').toLowerCase();
  const provider = providerRaw || defaultProvider();
  if (providerRaw && !LLMFactory.hasProvider(providerRaw)) {
    RuntimeUtil.makeLog('warn', `[AiWorkflow] 不支持的 LLM 提供商: ${providerRaw}`, 'AiWorkflow');
  }

  const providerConfig = LLMFactory.getProviderConfig(provider) || {};
  const runtimeConfig = stream.config || {};

  const apiKey = pickTrimmed(
    apiConfig.apiKey,
    apiConfig.api_key,
    runtimeConfig.apiKey,
    runtimeConfig.api_key,
    providerConfig.apiKey,
    providerConfig.api_key
  ) || undefined;
  const baseUrl = pickNonEmptyUrl(
    apiConfig.baseUrl,
    apiConfig.base_url,
    runtimeConfig.baseUrl,
    runtimeConfig.base_url,
    providerConfig.baseUrl,
    providerConfig.base_url
  );

  const headers = shallowMergePlain(providerConfig.headers, runtimeConfig.headers, apiConfig.headers);
  const extraBody = shallowMergePlain(providerConfig.extraBody, runtimeConfig.extraBody, apiConfig.extraBody);
  const proxy = shallowMergePlain(providerConfig.proxy, runtimeConfig.proxy, apiConfig.proxy);

  // 先 spread 保留 providers[] 中的厂商扩展字段（thinkingType、region、deployment 等）
  const variantPatch = resolveProviderVariantPatch(providerConfig, apiConfig);
  const merged = {
    ...providerConfig,
    ...runtimeConfig,
    ...apiConfig,
    ...variantPatch
  };

  assignDefined(merged, {
    apiKey,
    baseUrl,
    provider,
    timeout: pick(
      apiConfig.timeout,
      apiConfig.timeoutMs,
      runtimeConfig.timeout,
      providerConfig.timeout,
      llm.timeout,
      ai.global?.maxTimeout
    ),
    model: pick(
      apiConfig.model,
      apiConfig.chatModel,
      runtimeConfig.model,
      runtimeConfig.chatModel,
      providerConfig.model,
      providerConfig.chatModel
    ),
    maxTokens: pick(
      apiConfig.maxTokens,
      apiConfig.max_tokens,
      apiConfig.max_completion_tokens,
      apiConfig.maxCompletionTokens,
      runtimeConfig.maxTokens,
      runtimeConfig.max_tokens,
      providerConfig.maxTokens,
      providerConfig.max_tokens,
      llm.maxTokens,
      llm.max_tokens
    ),
    contextWindow: pick(
      apiConfig.contextWindow,
      apiConfig.context_window,
      runtimeConfig.contextWindow,
      runtimeConfig.context_window,
      providerConfig.contextWindow,
      providerConfig.context_window,
      llm.contextWindow,
      llm.context_window
    ),
    topP: pick(
      apiConfig.topP,
      apiConfig.top_p,
      runtimeConfig.topP,
      runtimeConfig.top_p,
      providerConfig.topP,
      providerConfig.top_p,
      llm.topP,
      llm.top_p
    ),
    presencePenalty: pick(
      apiConfig.presencePenalty,
      apiConfig.presence_penalty,
      runtimeConfig.presencePenalty,
      runtimeConfig.presence_penalty,
      providerConfig.presencePenalty,
      providerConfig.presence_penalty,
      llm.presencePenalty,
      llm.presence_penalty
    ),
    frequencyPenalty: pick(
      apiConfig.frequencyPenalty,
      apiConfig.frequency_penalty,
      runtimeConfig.frequencyPenalty,
      runtimeConfig.frequency_penalty,
      providerConfig.frequencyPenalty,
      providerConfig.frequency_penalty,
      llm.frequencyPenalty,
      llm.frequency_penalty
    ),
    temperature: pick(
      apiConfig.temperature,
      runtimeConfig.temperature,
      providerConfig.temperature,
      llm.temperature
    ),
    enableTools: pick(
      apiConfig.enableTools,
      apiConfig.enable_tools,
      runtimeConfig.enableTools,
      runtimeConfig.enable_tools,
      providerConfig.enableTools,
      providerConfig.enable_tools,
      llm.enableTools,
      llm.enable_tools,
      true
    ),
    enableStream: pick(
      apiConfig.enableStream,
      apiConfig.enable_stream,
      runtimeConfig.enableStream,
      runtimeConfig.enable_stream,
      providerConfig.enableStream,
      providerConfig.enable_stream,
      llm.enableStream,
      llm.enable_stream
    ),
    tool_choice: pick(
      apiConfig.tool_choice,
      apiConfig.toolChoice,
      runtimeConfig.tool_choice,
      runtimeConfig.toolChoice,
      providerConfig.tool_choice,
      providerConfig.toolChoice,
      llm.tool_choice,
      llm.toolChoice
    ),
    toolChoice: pick(
      apiConfig.tool_choice,
      apiConfig.toolChoice,
      runtimeConfig.tool_choice,
      runtimeConfig.toolChoice,
      providerConfig.tool_choice,
      providerConfig.toolChoice,
      llm.tool_choice,
      llm.toolChoice
    ),
    parallel_tool_calls: pick(
      apiConfig.parallel_tool_calls,
      apiConfig.parallelToolCalls,
      runtimeConfig.parallel_tool_calls,
      runtimeConfig.parallelToolCalls,
      providerConfig.parallel_tool_calls,
      providerConfig.parallelToolCalls,
      llm.parallel_tool_calls,
      llm.parallelToolCalls
    ),
    parallelToolCalls: pick(
      apiConfig.parallel_tool_calls,
      apiConfig.parallelToolCalls,
      runtimeConfig.parallel_tool_calls,
      runtimeConfig.parallelToolCalls,
      providerConfig.parallel_tool_calls,
      providerConfig.parallelToolCalls,
      llm.parallel_tool_calls,
      llm.parallelToolCalls
    ),
    maxToolRounds: pick(
      apiConfig.maxToolRounds,
      runtimeConfig.maxToolRounds,
      providerConfig.maxToolRounds,
      llm.maxToolRounds
    ),
    promptCache: pick(
      apiConfig.promptCache,
      runtimeConfig.promptCache,
      llm.promptCache
    )
  });

  if (Object.keys(headers).length) merged.headers = headers;
  if (Object.keys(extraBody).length) merged.extraBody = extraBody;
  if (Object.keys(proxy).length) merged.proxy = proxy;

  const { _clientClass, factoryType, ...out } = merged;
  return out;
}

