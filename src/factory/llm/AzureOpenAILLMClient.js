import { createLlmHttpError } from '#utils/llm/llm-http-error.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '#utils/llm/openai-chat-utils.js';
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { ensureMessagesImagesDataUrl } from '#utils/llm/image-utils.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { logPromptCacheUsage } from '#utils/llm/prompt-cache-policy.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';

/**
 * Azure OpenAI / Foundry Chat Completions 客户端
 * @see https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
 * @see https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/chat
 *
 * - 经典部署：`/openai/deployments/{deployment}/chat/completions?api-version=YYYY-MM-DD`
 * - Foundry v1：`path=/openai/v1/chat/completions`（`api-version` 可选；body 带 `model`）
 * - 认证：默认 header `api-key`；Microsoft Entra：`authMode: bearer` → `Authorization: Bearer`
 * - deployment（真实部署名）在 yaml；对外 model=provider 约定不变
 */
export default class AzureOpenAILLMClient {
  _timeout = 360000;

  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('azure_openai: 未配置 baseUrl（Azure endpoint）');

    const deployment = encodeURIComponent(config.deployment ?? config.azureDeployment ?? config.model ?? config.chatModel ?? '');
    if (!deployment && !config.path) throw new Error('azure_openai: 未配置 deployment（Azure 部署名）或 path');

    const path = (config.path || `/openai/deployments/${deployment}/chat/completions`).replace(/^\/?/, '/');
    const apiVersion = (config.apiVersion || '').toString().trim();
    const url = new URL(`${base}${path}`);
    if (apiVersion) {
      url.searchParams.set('api-version', apiVersion);
    }
    return url.toString();
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  buildHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...extra
    };

    if (this.config.apiKey) {
      const key = String(this.config.apiKey).trim();
      const mode = String(this.config.authMode ?? 'api-key').trim().toLowerCase();
      if (mode === 'bearer') {
        headers.Authorization = `Bearer ${key}`;
      } else {
        headers['api-key'] = key;
      }
    }

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  async transformMessages(messages) {
    return await transformMessagesWithVision(messages, this.config, { mode: 'openai' });
  }

  buildBody(messages, overrides = {}) {
    const body = buildOpenAIChatCompletionsBody(messages, this.config, overrides, undefined);
    const pathHint = String(this.config.path || this.endpoint || '');
    const isFoundryV1 = /\/openai\/v1\//i.test(pathHint);

    if (isFoundryV1) {
      if (body.model === undefined || body.model === '') {
        body.model =
          overrides.model ||
          overrides.chatModel ||
          this.config.model ||
          this.config.chatModel ||
          this.config.deployment ||
          this.config.azureDeployment;
      }
    } else {
      // 经典 deployments/{name}/chat/completions：模型由路径决定，勿再传 model
      delete body.model;
    }

    applyOpenAITools(body, this.config, overrides);
    return body;
  }

  async chat(messages, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    await ensureMessagesImagesDataUrl(transformedMessages, { timeoutMs: this.timeout });
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
        `AzureOpenAILLMClient 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers }
      );
    }

    const json = await resp.json();
    logPromptCacheUsage(json?.usage, 'AzureOpenAILLMClient');
    const message = json?.choices?.[0]?.message;
    const content = message?.content || '';
    if (message?.tool_calls?.length) {
      RuntimeUtil.makeLog(
        'info',
        `[AzureOpenAILLMClient] 单次补全含 tool_calls×${message.tool_calls.length}（本客户端不执行工具）`,
        'LLMFactory',
      );
      return { content, tool_calls: message.tool_calls };
    }
    return content;
  }

  async chatStream(messages, onDelta, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    await ensureMessagesImagesDataUrl(transformedMessages, { timeoutMs: this.timeout });
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
      throw new Error(`AzureOpenAILLMClient 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
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
        `[AzureOpenAILLMClient] 流式单次补全含 tool_calls×${collector.toolCalls.length}（本客户端不执行工具）`,
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
        // ignore malformed SSE chunk
      }
    }

    if (toolCallsMap.size > 0) {
      const sortedIndices = Array.from(toolCallsMap.keys()).sort((a, b) => a - b);
      collector.toolCalls = sortedIndices.map(index => toolCallsMap.get(index));
    }
  }
}
