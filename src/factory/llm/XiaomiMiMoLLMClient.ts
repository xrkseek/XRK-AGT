import { createLlmHttpError } from '#utils/llm/llm-http-error.js';
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '#utils/llm/openai-chat-utils.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { createToolNameMapper } from '#utils/llm/tool-name-utils.js';
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
  thinkingType?: string;
  thinking_type?: string;
  response_format?: unknown;
  responseFormat?: unknown;
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
  thinkingType?: string;
  thinking_type?: string;
  response_format?: unknown;
  responseFormat?: unknown;
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
  thinking?: { type: unknown };
  response_format?: unknown;
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
      reasoning_content?: string;
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
 * ?? MiMo LLM ???
 * @see https://mimo.mi.com/docs/en-US/api/chat/openai-api
 *
 * - baseUrl: https://api.xiaomimimo.com/v1 � path: /chat/completions
 * - ???`api-key`????? `authMode: bearer` ? Authorization
 * - ?? `thinking: { type }`??? `max_completion_tokens`
 * - ??????????? text_only ??
 *
 * harness???? createXiaomiAdapter?? OpenAICompatible ???????? Chat Completions ?????
 */
export default class XiaomiMiMoLLMClient {
  config: LlmClientConfig;
  endpoint: string;
  _toolNames = createToolNameMapper();
  _timeout = 360000;

  constructor(config: LlmClientConfig = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = Number(config.timeout ?? 360000);
  }

  normalizeEndpoint(config: LlmClientConfig) {
    const base = (config.baseUrl || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '');
    const path = (config.path || '/chat/completions').replace(/^\/?/, '/');
    return `${base}${path}`;
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
      const mode = String(this.config.authMode || 'api-key').toLowerCase();
      if (mode === 'bearer') {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      } else {
        headers['api-key'] = String(this.config.apiKey);
      }
    }

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  async transformMessages(messages: ChatMessage[]) {
    return await transformMessagesWithVision(messages, this.config, { mode: 'text_only' });
  }

  buildBody(messages: ChatMessage[], overrides: LlmOverrides = {}): ChatCompletionBody {
    const normalizedMessages = this._toolNames.normalizeMessages(messages);
    const defaultModel = this.config.model || this.config.chatModel || 'mimo-v2-flash';
    const body = buildOpenAIChatCompletionsBody(
      normalizedMessages,
      this.config,
      overrides,
      defaultModel,
    ) as ChatCompletionBody;
    applyOpenAITools(body, this.config, overrides);

    const thinkingType =
      overrides.thinkingType ?? overrides.thinking_type ?? this.config.thinkingType ?? this.config.thinking_type;
    if (thinkingType !== undefined && thinkingType !== '') {
      body.thinking = { type: thinkingType };
    }

    const rf =
      overrides.response_format ?? overrides.responseFormat ?? this.config.response_format ?? this.config.responseFormat;
    if (rf !== undefined) {
      const type = typeof rf === 'string' ? rf.trim() : (rf as { type?: string })?.type;
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

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      body.tools = this._toolNames.normalizeTools(body.tools) as unknown[];
    }

    return body;
  }

  async chat(messages: ChatMessage[], overrides: LlmOverrides = {}) {
    const transformedMessages = await this.transformMessages(messages);

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
        `XiaomiMiMoLLMClient ????: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers as { get?: (name: string) => string | null } },
      );
    }

    const json = (await resp.json()) as ChatCompletionResponse;
    logPromptCacheUsage(json?.usage, 'XiaomiMiMoLLMClient');
    const message = json?.choices?.[0]?.message;
    const content = message?.content || '';
    if (message?.tool_calls?.length) {
      RuntimeUtil.makeLog(
        'info',
        `[XiaomiMiMoLLMClient] ????? tool_calls�${message.tool_calls.length}???????????`,
        'LLMFactory',
      );
      return { content, tool_calls: message.tool_calls };
    }
    return content;
  }

  async chatStream(messages: ChatMessage[], onDelta: OnDeltaCallback, overrides: LlmOverrides = {}) {
    const transformedMessages = await this.transformMessages(messages);

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
      throw new Error(`XiaomiMiMoLLMClient ??????: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }

    const collector: StreamCollector = { toolCalls: [], content: '', reasoningContent: '', finishReason: null };
    await this._consumeSSEWithToolCalls(resp, onDelta, collector);
    if (collector.toolCalls.length) {
      RuntimeUtil.makeLog(
        'info',
        `[XiaomiMiMoLLMClient] ??????? tool_calls�${collector.toolCalls.length}???????????`,
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
        // ignore
      }
    }

    if (toolCallsMap.size > 0) {
      const sortedIndices = Array.from(toolCallsMap.keys()).sort((a, b) => a - b);
      collector.toolCalls = sortedIndices.map((index) => toolCallsMap.get(index)!);
    }
  }
}
