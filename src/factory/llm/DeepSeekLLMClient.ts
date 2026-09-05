// @ts-nocheck
import { createLlmHttpError } from '#utils/llm/llm-http-error.js';
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '#utils/llm/openai-chat-utils.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { createToolNameMapper } from '#utils/llm/tool-name-utils.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';
import { logPromptCacheUsage } from '#utils/llm/prompt-cache-policy.js';

/**
 * DeepSeek Chat Completions：`reasoning_effort` ∈ low | high | max
 * @see https://api-docs.deepseek.com/api/create-chat-completion
 * 兼容映射：medium / xhigh → high（官方兼容约定）
 */
function normalizeDeepSeekReasoningEffort(value) {
  if (value === undefined || value === null || value === '') return;
  const v = String(value).trim().toLowerCase();
  if (v === 'low') return 'low';
  if (v === 'max') return 'max';
  if (v === 'high' || v === 'medium' || v === 'xhigh') return 'high';
  return 'high';
}

function resolveThinkingType(overrides, config) {
  const raw = overrides.thinkingType ?? overrides.thinking_type ?? config.thinkingType ?? config.thinking_type;
  if (raw === undefined || raw === null || raw === '') return 'enabled';
  const v = String(raw).trim().toLowerCase();
  return v === 'disabled' ? 'disabled' : 'enabled';
}

function applyResponseFormat(body, overrides, config) {
  const rf = overrides.response_format ?? overrides.responseFormat ?? config.response_format ?? config.responseFormat;
  if (rf !== undefined) {
    const type = typeof rf === 'string' ? rf.trim() : rf?.type;
    if (type) body.response_format = { type };
    else delete body.response_format;
    return;
  }
  if (typeof body.response_format === 'string') {
    const type = body.response_format.trim();
    if (type) body.response_format = { type };
    else delete body.response_format;
  }
}

/**
 * DeepSeek 官方 LLM 客户端
 * @see https://api-docs.deepseek.com/zh-cn/
 */
export default class DeepSeekLLMClient {
  _toolNames = createToolNameMapper();
  _timeout = 360000;

  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    const path = (config.path || '/chat/completions').replace(/^\/?/, '/');
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  buildHeaders(extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${String(this.config.apiKey).trim()}`;
    }
    if (this.config.headers) Object.assign(headers, this.config.headers);
    return headers;
  }

  buildBody(messages, overrides = {}) {
    const defaultModel = this.config.model || this.config.chatModel || 'deepseek-v4-flash';
    const normalizedMessages = this._toolNames.normalizeMessages(messages);
    const body = buildOpenAIChatCompletionsBody(normalizedMessages, this.config, overrides, defaultModel);
    applyOpenAITools(body, this.config, overrides);

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      body.tools = this._toolNames.normalizeTools(body.tools);
    }

    const thinkingType = resolveThinkingType(overrides, this.config);
    body.thinking = { type: thinkingType };

    if (thinkingType === 'enabled') {
      delete body.temperature;
      delete body.top_p;
      delete body.presence_penalty;
      delete body.frequency_penalty;
      body.reasoning_effort = normalizeDeepSeekReasoningEffort(
        overrides.reasoning_effort ?? overrides.reasoningEffort ?? this.config.reasoningEffort ?? this.config.reasoning_effort
      ) || 'high';
    } else {
      delete body.reasoning_effort;
    }

    applyResponseFormat(body, overrides, this.config);

    const userId = overrides.user_id ?? overrides.userId ?? this.config.userId ?? this.config.user_id;
    if (userId !== undefined && userId !== null && String(userId).trim() !== '') {
      body.user_id = String(userId).trim();
    }

    return body;
  }

  async transformMessages(messages) {
    return await transformMessagesWithVision(messages, this.config, { mode: 'text_only' });
  }

  async chat(messages, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    
    const resp = await fetch(
      this.endpoint,
      buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(this.buildBody(transformedMessages, overrides)),
        signal: AbortSignal.timeout(this.timeout)
      })
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw createLlmHttpError(
        `DeepSeekLLMClient 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers }
      );
    }

    const json = await resp.json();
    logPromptCacheUsage(json?.usage, 'DeepSeekLLMClient');
    const message = json?.choices?.[0]?.message;
    const content = message?.content || '';
    if (message?.tool_calls?.length) {
      RuntimeUtil.makeLog(
        'info',
        `[DeepSeekLLMClient] 单次补全含 tool_calls×${message.tool_calls.length}（本客户端不执行工具）`,
        'LLMFactory',
      );
      return { content, tool_calls: message.tool_calls };
    }
    return content;
  }

  async chatStream(messages, onDelta, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    
    const resp = await fetch(
      this.endpoint,
      buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(this.buildBody(transformedMessages, { ...overrides, stream: true })),
        signal: AbortSignal.timeout(this.timeout)
      })
    );

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`DeepSeekLLMClient 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }

    const collector = { toolCalls: [], content: '', reasoningContent: '', finishReason: null };
    if (typeof this._consumeSSEWithToolCalls === 'function') {
      await this._consumeSSEWithToolCalls(resp, onDelta, collector, overrides);
    } else {
      // fallback: text-only SSE
      const { iterateSSE } = await import('#utils/llm/sse-utils.js');
      for await (const { data } of iterateSSE(resp)) {
        try {
          const j = JSON.parse(data);
          const delta = j?.choices?.[0]?.delta?.content;
          if (delta) {
            collector.content += delta;
            if (typeof onDelta === 'function') onDelta(delta);
          }
        } catch { /* ignore */ }
      }
    }
    if (collector.toolCalls.length) {
      RuntimeUtil.makeLog(
        'info',
        `[DeepSeekLLMClient] 流式单次补全含 tool_calls×${collector.toolCalls.length}（本客户端不执行工具）`,
        'LLMFactory',
      );
    }
    return collector.content;
  }

  async _consumeSSEWithToolCalls(resp, onDelta, collector, options = {}) {
    const toolCallsMap = new Map();
    for await (const { data } of iterateSSE(resp)) {
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta;
        const finishReason = json?.choices?.[0]?.finish_reason;

        if (finishReason) collector.finishReason = finishReason;

        if (delta?.reasoning_content) {
          collector.reasoningContent += delta.reasoning_content;
          if (typeof onDelta === 'function') onDelta('', { reasoning_content: delta.reasoning_content });
        }

        if (delta?.content) {
          collector.content += delta.content;
          if (typeof onDelta === 'function') onDelta(delta.content);
        }

        if (delta?.tool_calls?.length) {
          if (typeof onDelta === 'function') {
            onDelta('', { tool_calls: delta.tool_calls });
          }
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            if (index === undefined || index === null) continue;
            if (!toolCallsMap.has(index)) {
              toolCallsMap.set(index, { id: '', type: 'function', function: { name: '', arguments: '' } });
            }
            const toolCall = toolCallsMap.get(index);
            if (tc.id) toolCall.id = tc.id;
            if (tc.function?.name) toolCall.function.name = tc.function.name;
            if (tc.function?.arguments) toolCall.function.arguments += tc.function.arguments;
          }
        }
      } catch {
        // ignore malformed SSE chunk
      }
    }

    if (toolCallsMap.size > 0) {
      collector.toolCalls = Array.from(toolCallsMap.keys()).sort((a, b) => a - b).map((i) => toolCallsMap.get(i));
    }
  }
}
