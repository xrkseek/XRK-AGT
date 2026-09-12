import { createLlmHttpError } from '#utils/llm/llm-http-error.js';
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildOpenAIChatCompletionsBody, applyOpenAITools } from '#utils/llm/openai-chat-utils.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { createToolNameMapper } from '#utils/llm/tool-name-utils.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';
import { logPromptCacheUsage } from '#utils/llm/prompt-cache-policy.js';

type LlmClientConfig = Record<string, unknown> & {
  model?: string;
  chatModel?: string;
  baseUrl?: string;
  path?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeout?: number;
  thinkingType?: string;
  thinking_type?: string;
  reasoningEffort?: string;
  reasoning_effort?: string;
  response_format?: unknown;
  responseFormat?: unknown;
  userId?: string;
  user_id?: string;
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
  reasoning_effort?: string;
  reasoningEffort?: string;
  response_format?: unknown;
  responseFormat?: unknown;
  user_id?: string;
  userId?: string;
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
  thinking?: { type: string };
  reasoning_effort?: string;
  temperature?: unknown;
  top_p?: unknown;
  presence_penalty?: unknown;
  frequency_penalty?: unknown;
  response_format?: unknown;
  user_id?: string;
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
 * DeepSeek Chat Completions?`reasoning_effort` ? low | high | max
 * @see https://api-docs.deepseek.com/api/create-chat-completion
 * ?????medium / xhigh ? high????????
 */
function normalizeDeepSeekReasoningEffort(value: unknown): 'low' | 'high' | 'max' | undefined {
  if (value === undefined || value === null || value === '') return;
  const v = String(value).trim().toLowerCase();
  if (v === 'low') return 'low';
  if (v === 'max') return 'max';
  if (v === 'high' || v === 'medium' || v === 'xhigh') return 'high';
  return 'high';
}

function resolveThinkingType(overrides: LlmOverrides, config: LlmClientConfig): 'enabled' | 'disabled' {
  const raw = overrides.thinkingType ?? overrides.thinking_type ?? config.thinkingType ?? config.thinking_type;
  if (raw === undefined || raw === null || raw === '') return 'enabled';
  const v = String(raw).trim().toLowerCase();
  return v === 'disabled' ? 'disabled' : 'enabled';
}

function applyResponseFormat(body: ChatCompletionBody, overrides: LlmOverrides, config: LlmClientConfig) {
  const rf = overrides.response_format ?? overrides.responseFormat ?? config.response_format ?? config.responseFormat;
  if (rf !== undefined) {
    const type = typeof rf === 'string' ? rf.trim() : (rf as { type?: string })?.type;
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
 * DeepSeek ?? LLM ???
 * @see https://api-docs.deepseek.com/zh-cn/
 *
 * harness ???`createLlmFromConfig` ? provider~/deepseek/ ? `createDeepSeekAdapter`?
 * ??????? LLMFactory ?????????????
 */
export default class DeepSeekLLMClient {
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
    const base = (config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    const path = (config.path || '/chat/completions').replace(/^\/?/, '/');
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  buildHeaders(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${String(this.config.apiKey).trim()}`;
    }
    if (this.config.headers) Object.assign(headers, this.config.headers);
    return headers;
  }

  buildBody(messages: ChatMessage[], overrides: LlmOverrides = {}): ChatCompletionBody {
    const defaultModel = this.config.model || this.config.chatModel || 'deepseek-v4-flash';
    const normalizedMessages = this._toolNames.normalizeMessages(messages);
    const body = buildOpenAIChatCompletionsBody(
      normalizedMessages,
      this.config,
      overrides,
      defaultModel,
    ) as ChatCompletionBody;
    applyOpenAITools(body, this.config, overrides);

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      body.tools = this._toolNames.normalizeTools(body.tools) as unknown[];
    }

    const thinkingType = resolveThinkingType(overrides, this.config);
    body.thinking = { type: thinkingType };

    if (thinkingType === 'enabled') {
      delete body.temperature;
      delete body.top_p;
      delete body.presence_penalty;
      delete body.frequency_penalty;
      body.reasoning_effort = normalizeDeepSeekReasoningEffort(
        overrides.reasoning_effort ?? overrides.reasoningEffort ?? this.config.reasoningEffort ?? this.config.reasoning_effort,
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

  async transformMessages(messages: ChatMessage[]) {
    return await transformMessagesWithVision(messages, this.config, { mode: 'text_only' });
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
        `DeepSeekLLMClient ????: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers as { get?: (name: string) => string | null } },
      );
    }

    const json = (await resp.json()) as ChatCompletionResponse;
    logPromptCacheUsage(json?.usage, 'DeepSeekLLMClient');
    const message = json?.choices?.[0]?.message;
    const content = message?.content || '';
    if (message?.tool_calls?.length) {
      RuntimeUtil.makeLog(
        'info',
        `[DeepSeekLLMClient] ????? tool_calls�${message.tool_calls.length}???????????`,
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
      throw new Error(`DeepSeekLLMClient ??????: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }

    const collector: StreamCollector = { toolCalls: [], content: '', reasoningContent: '', finishReason: null };
    await this._consumeSSEWithToolCalls(resp, onDelta, collector);
    if (collector.toolCalls.length) {
      RuntimeUtil.makeLog(
        'info',
        `[DeepSeekLLMClient] ??????? tool_calls�${collector.toolCalls.length}???????????`,
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
            const toolCall = toolCallsMap.get(index)!;
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
      collector.toolCalls = Array.from(toolCallsMap.keys())
        .sort((a, b) => a - b)
        .map((i) => toolCallsMap.get(i)!);
    }
  }
}
