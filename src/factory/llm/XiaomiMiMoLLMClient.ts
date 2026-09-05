// @ts-nocheck
import { createLlmHttpError } from '#utils/llm/llm-http-error.js';
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '#utils/llm/openai-chat-utils.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { createToolNameMapper } from '#utils/llm/tool-name-utils.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { logPromptCacheUsage } from '#utils/llm/prompt-cache-policy.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';

/**
 * 小米 MiMo LLM 客户端
 * @see https://mimo.mi.com/docs/en-US/api/chat/openai-api
 *
 * - baseUrl: https://api.xiaomimimo.com/v1 · path: /chat/completions
 * - 认证：`api-key`（默认）或 `authMode: bearer` → Authorization
 * - 可选 `thinking: { type }`；出站 `max_completion_tokens`
 * - 纯文本模型：图片由上游 text_only 占位
 */
export default class XiaomiMiMoLLMClient {
  _toolNames = createToolNameMapper();

  _timeout = 360000;

  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  /**
   * 规范化端点地址
   */
  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
    const path = (config.path || '/chat/completions').replace(/^\/?/, '/');
    return `${base}${path}`;
  }

  /**
   * 获取超时时间
   */
  get timeout() {
    return this._timeout ?? 360000;
  }

  /**
   * 构建请求头
   */
  buildHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...extra
    };

    // 小米 MiMo 支持两种认证方式：api-key 或 Authorization: Bearer
    if (this.config.apiKey) {
      const mode = (this.config.authMode || 'api-key').toLowerCase();
      if (mode === 'bearer') {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      } else {
        headers['api-key'] = this.config.apiKey;
      }
    }

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  async transformMessages(messages) {
    // MiMo 当前仅文本，退化为 text_only，占位拼接图片 URL / base64 方便调试
    return await transformMessagesWithVision(messages, this.config, { mode: 'text_only' });
  }

  /**
   * 构建请求体（OpenAI 兼容格式）
   * 小米 MiMo API 使用 max_completion_tokens 而非 max_tokens
   * 支持高级参数：stop、thinking、tool_choice、tools、response_format
   */
  buildBody(messages, overrides = {}) {
    // 规范化消息中的 tool_calls（历史回合 seed 需要）
    const normalizedMessages = this._toolNames.normalizeMessages(messages);

    // 复用 OpenAI-like 归一化逻辑，确保：
    // - extraBody 生效
    // - parallel_tool_calls / tool_choice 兼容
    // - maxTokens 同时映射到 max_completion_tokens / max_tokens（MiMo 使用前者）
    const defaultModel = this.config.model || this.config.chatModel || 'mimo-v2-flash';
    const body = buildOpenAIChatCompletionsBody(normalizedMessages, this.config, overrides, defaultModel);
    applyOpenAITools(body, this.config, overrides);

    // MiMo 扩展字段
    const thinkingType = overrides.thinkingType ?? overrides.thinking_type ?? this.config.thinkingType ?? this.config.thinking_type;
    if (thinkingType !== undefined && thinkingType !== '') {
      body.thinking = { type: thinkingType };
    }

    // MiMo: response_format 官方为对象，这里兼容 string/对象两种写法
    const rf = overrides.response_format ?? overrides.responseFormat ?? this.config.response_format ?? this.config.responseFormat;
    if (rf !== undefined) {
      const type = typeof rf === 'string' ? rf.trim() : rf?.type;
      if (type) {
        body.response_format = { type };
      } else {
        delete body.response_format;
      }
    } else if (typeof body.response_format === 'string') {
      const type = body.response_format.trim();
      if (type) body.response_format = { type };
      else delete body.response_format;
    }

    // MiMo 对 tool.name 有严格限制：出站 tools 需要规范化名称
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      body.tools = this._toolNames.normalizeTools(body.tools);
    }

    return body;
  }

  /**
   * 非流式调用（支持工具调用）
   * @param {Array} messages - 消息数组
   * @param {Object} overrides - 覆盖配置
   * @returns {Promise<string>} AI 回复文本
   */
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
        `XiaomiMiMoLLMClient 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers }
      );
    }

    const json = await resp.json();
    logPromptCacheUsage(json?.usage, 'XiaomiMiMoLLMClient');
    const message = json?.choices?.[0]?.message;
    const content = message?.content || '';
    if (message?.tool_calls?.length) {
      RuntimeUtil.makeLog(
        'info',
        `[XiaomiMiMoLLMClient] 单次补全含 tool_calls×${message.tool_calls.length}（本客户端不执行工具）`,
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
      throw new Error(`XiaomiMiMoLLMClient 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
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
        `[XiaomiMiMoLLMClient] 流式单次补全含 tool_calls×${collector.toolCalls.length}（本客户端不执行工具）`,
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

        if (finishReason) {
          collector.finishReason = finishReason;
        }

        if (delta?.reasoning_content && typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          collector.reasoningContent += delta.reasoning_content;
          if (typeof onDelta === 'function') onDelta('', { reasoning_content: delta.reasoning_content });
        }

        if (delta?.content && typeof delta.content === 'string' && delta.content.length > 0) {
          collector.content += delta.content;
          if (typeof onDelta === 'function') onDelta(delta.content);
        }

        if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
          if (typeof onDelta === 'function' && delta.tool_calls.length > 0) {
            onDelta('', { tool_calls: delta.tool_calls });
          }
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            if (index === undefined || index === null) continue;

            if (!toolCallsMap.has(index)) {
              toolCallsMap.set(index, {
                id: '',
                type: 'function',
                function: { name: '', arguments: '' }
              });
            }

            const toolCall = toolCallsMap.get(index);
            if (tc.id) toolCall.id = tc.id;
            if (tc.function?.name) toolCall.function.name = tc.function.name;
            if (tc.function?.arguments) {
              toolCall.function.arguments += tc.function.arguments;
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (toolCallsMap.size > 0) {
      const sortedIndices = Array.from(toolCallsMap.keys()).sort((a, b) => a - b);
      collector.toolCalls = sortedIndices.map(index => toolCallsMap.get(index));
    }
  }
}
