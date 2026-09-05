import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '#utils/llm/openai-chat-utils.js';
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { ensureMessagesImagesDataUrl } from '#utils/llm/image-utils.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { logPromptCacheUsage } from '#utils/llm/prompt-cache-policy.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';
import { createLlmHttpError } from '#utils/llm/llm-http-error.js';

/**
 * OpenAI 官方 LLM 客户端（Chat Completions）
 * 文档：https://platform.openai.com/docs/api-reference/chat
 *
 * - baseUrl 默认 `https://api.openai.com/v1`，path `/chat/completions`
 * - 认证：`Authorization: Bearer ${apiKey}`
 * - 多模态：messages[].content 可为 text + image_url（含 base64 data URL）
 * - tool calling：OpenAI tools/tool_calls（单次补全；MCP 多轮在 harness）
 */
export default class OpenAILLMClient {
  [key: string]: any;
  _timeout = 360000;

  constructor(config: any = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  normalizeEndpoint(config: any) {
    const base = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const path = (config.path || '/chat/completions').replace(/^\/?/, '/');
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  buildHeaders(extra: any = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...extra
    };

    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${String(this.config.apiKey).trim()}`;
    }

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  async transformMessages(messages: any) {
    // OpenAI 官方多模态，使用 openai 模式，允许 base64 封装为 data URL
    return await transformMessagesWithVision(messages, this.config, { mode: 'openai' });
  }

  buildBody(messages: any, overrides: any = {}) {
    const defaultModel = this.config.model || this.config.chatModel;
    const body = buildOpenAIChatCompletionsBody(messages, this.config, overrides, defaultModel);
    applyOpenAITools(body, this.config, overrides);
    return body;
  }

  async chat(messages: any, overrides: any = {}) {
    const transformedMessages = await this.transformMessages(messages);
    await ensureMessagesImagesDataUrl(transformedMessages, { timeoutMs: this.timeout });
    const resp = await fetch(
      this.endpoint,
      (buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(this.buildBody(transformedMessages, overrides)),
        signal: AbortSignal.timeout(this.timeout)
      }) as any)
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw createLlmHttpError(
        `OpenAILLMClient 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers as any }
      );
    }

    const json: any = await resp.json();
    logPromptCacheUsage(json?.usage, 'OpenAILLMClient');
    const message = json?.choices?.[0]?.message;
    const content = message?.content || '';
    if (message?.tool_calls?.length) {
      RuntimeUtil.makeLog(
        'info',
        `[OpenAILLMClient] 单次补全含 tool_calls×${message.tool_calls.length}（本客户端不执行工具）`,
        'LLMFactory',
      );
      return { content, tool_calls: message.tool_calls };
    }
    return content;
  }

  async chatStream(messages: any, onDelta: any, overrides: any = {}) {
    const transformedMessages = await this.transformMessages(messages);
    await ensureMessagesImagesDataUrl(transformedMessages, { timeoutMs: this.timeout });
    const resp = await fetch(
      this.endpoint,
      (buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(this.buildBody(transformedMessages, { ...overrides, stream: true })),
        signal: AbortSignal.timeout(this.timeout)
      }) as any)
    );

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`OpenAILLMClient 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }

    const collector = { toolCalls: [], content: '', reasoningContent: '', finishReason: null };
    if (typeof this._consumeSSEWithToolCalls === 'function') {
      await this._consumeSSEWithToolCalls(resp, onDelta, collector, overrides);
    } else {
      // fallback: text-only SSE
      const { iterateSSE } = await import('#utils/llm/sse-utils.js');
      for await (const { data } of iterateSSE(resp as any)) {
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
        `[OpenAILLMClient] 流式单次补全含 tool_calls×${collector.toolCalls.length}（本客户端不执行工具）`,
        'LLMFactory',
      );
    }
    return collector.content;
  }

  async _consumeSSEWithToolCalls(resp: any, onDelta: any, collector: any, options: any = {}) {
    const toolCallsMap = new Map();
    for await (const { data } of iterateSSE(resp as any)) {
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta;
        const finishReason = json?.choices?.[0]?.finish_reason;

        if (finishReason) {
          collector.finishReason = finishReason;
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

