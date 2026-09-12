import { createLlmHttpError } from '#utils/llm/llm-http-error.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '#utils/llm/openai-chat-utils.js';
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { ensureMessagesImagesDataUrl } from '#utils/llm/image-utils.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { logPromptCacheUsage } from '#utils/llm/prompt-cache-policy.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';

type LlmClientConfig = Record<string, unknown> & {
  model?: string;
  chatModel?: string;
  baseUrl?: string;
  path?: string;
  apiKey?: string;
  authMode?: string;
  headers?: Record<string, string>;
  timeout?: number;
  deployment?: string;
  azureDeployment?: string;
  apiVersion?: string;
  proxy?: unknown;
};

type ChatMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
};

type LlmOverrides = Record<string, unknown> & {
  headers?: Record<string, string>;
  stream?: boolean;
  model?: string;
  chatModel?: string;
};

type OnDeltaCallback = (chunk: string, meta?: Record<string, unknown>) => void;

type ToolCallDelta = {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type ToolCallAccumulator = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type ChatCompletionBody = Record<string, unknown> & {
  model?: string;
  tools?: unknown[];
};

type ChatCompletionResponse = {
  usage?: unknown;
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: unknown[];
    };
    delta?: {
      content?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
};

type StreamCollector = {
  toolCalls: ToolCallAccumulator[];
  content: string;
  reasoningContent: string;
  finishReason: string | null;
};

/**
 * Azure OpenAI / Foundry Chat Completions ???
 * @see https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
 * @see https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/chat
 *
 * - ?????`/openai/deployments/{deployment}/chat/completions?api-version=YYYY-MM-DD`
 * - Foundry v1?`path=/openai/v1/chat/completions`?`api-version` ???body ? `model`?
 * - ????? header `api-key`?Microsoft Entra?`authMode: bearer` ? `Authorization: Bearer`
 * - deployment???????? yaml??? model=provider ????
 *
 * harness???? Azure adapter?? OpenAICompatible?Chat Completions????????????
 */
export default class AzureOpenAILLMClient {
  config: LlmClientConfig;
  endpoint: string;
  _timeout = 360000;

  constructor(config: LlmClientConfig = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = Number(config.timeout ?? 360000);
  }

  normalizeEndpoint(config: LlmClientConfig) {
    const base = String(config.baseUrl ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('azure_openai: ??? baseUrl?Azure endpoint?');

    const deployment = encodeURIComponent(
      String(config.deployment ?? config.azureDeployment ?? config.model ?? config.chatModel ?? ''),
    );
    if (!deployment && !config.path) throw new Error('azure_openai: ??? deployment?Azure ????? path');

    const path = (config.path || `/openai/deployments/${deployment}/chat/completions`).replace(/^\/?/, '/');
    const apiVersion = String(config.apiVersion || '').trim();
    const url = new URL(`${base}${path}`);
    if (apiVersion) {
      url.searchParams.set('api-version', apiVersion);
    }
    return url.toString();
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  buildHeaders(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
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

  async transformMessages(messages: ChatMessage[]) {
    return await transformMessagesWithVision(messages, this.config, { mode: 'openai' });
  }

  buildBody(messages: ChatMessage[], overrides: LlmOverrides = {}): ChatCompletionBody {
    const body = buildOpenAIChatCompletionsBody(messages, this.config, overrides, undefined) as ChatCompletionBody;
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
      // ?? deployments/{name}/chat/completions???????????? model
      delete body.model;
    }

    applyOpenAITools(body, this.config, overrides);
    return body;
  }

  async chat(messages: ChatMessage[], overrides: LlmOverrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    await ensureMessagesImagesDataUrl(transformedMessages, { timeoutMs: this.timeout });
    const resp = await fetch(
      this.endpoint,
      buildFetchOptionsWithProxy(this.config as Parameters<typeof buildFetchOptionsWithProxy>[0], {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(this.buildBody(transformedMessages as ChatMessage[], overrides)),
        signal: AbortSignal.timeout(this.timeout),
      }) as RequestInit,
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw createLlmHttpError(
        `AzureOpenAILLMClient ????: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers as { get?: (name: string) => string | null } },
      );
    }

    const json = (await resp.json()) as ChatCompletionResponse;
    logPromptCacheUsage(json?.usage, 'AzureOpenAILLMClient');
    const message = json?.choices?.[0]?.message;
    const content = message?.content || '';
    if (message?.tool_calls?.length) {
      RuntimeUtil.makeLog(
        'info',
        `[AzureOpenAILLMClient] ????? tool_calls�${message.tool_calls.length}???????????`,
        'LLMFactory',
      );
      return { content, tool_calls: message.tool_calls };
    }
    return content;
  }

  async chatStream(messages: ChatMessage[], onDelta: OnDeltaCallback, overrides: LlmOverrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    await ensureMessagesImagesDataUrl(transformedMessages, { timeoutMs: this.timeout });
    const resp = await fetch(
      this.endpoint,
      buildFetchOptionsWithProxy(this.config as Parameters<typeof buildFetchOptionsWithProxy>[0], {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(this.buildBody(transformedMessages as ChatMessage[], { ...overrides, stream: true })),
        signal: AbortSignal.timeout(this.timeout),
      }) as RequestInit,
    );

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw new Error(`AzureOpenAILLMClient ??????: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }

    const collector: StreamCollector = { toolCalls: [], content: '', reasoningContent: '', finishReason: null };
    await this._consumeSSEWithToolCalls(resp, onDelta, collector);
    if (collector.toolCalls.length) {
      RuntimeUtil.makeLog(
        'info',
        `[AzureOpenAILLMClient] ??????? tool_calls�${collector.toolCalls.length}???????????`,
        'LLMFactory',
      );
    }
    return collector.content;
  }

  async _consumeSSEWithToolCalls(
    resp: Response,
    onDelta: OnDeltaCallback,
    collector: StreamCollector,
  ) {
    const toolCallsMap = new Map<number, ToolCallAccumulator>();

    for await (const { data } of iterateSSE(resp as Parameters<typeof iterateSSE>[0])) {
      try {
        const json = JSON.parse(data) as ChatCompletionResponse;
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
                function: { name: '', arguments: '' },
              });
            }

            const toolCall = toolCallsMap.get(index)!;
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
      collector.toolCalls = sortedIndices.map((index) => toolCallsMap.get(index)!);
    }
  }
}
