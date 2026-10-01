import { buildOpenAIChatCompletionsBody, applyOpenAITools, buildOpenAICompatEndpoint } from '#utils/llm/openai-chat-utils.js';
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { ensureMessagesImagesDataUrl } from '#utils/llm/image-utils.js';
import { cleanupMessages } from '#utils/llm/message-cleanup.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';
import { logPromptCacheUsage } from '#utils/llm/prompt-cache-policy.js';
import { createLlmHttpError } from '#utils/llm/llm-http-error.js';
import { normalizeError } from '#utils/normalize-error.js';

type LlmClientConfig = Record<string, unknown> & {
  model?: string;
  chatModel?: string;
  baseUrl?: string;
  apiKey?: string;
  authMode?: string;
  authHeaderName?: string;
  headers?: Record<string, string>;
  timeout?: number;
  stripToolTraces?: boolean;
  tools?: unknown[];
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
};

type OnDeltaCallback = (chunk: string, meta?: Record<string, unknown>) => void;

type ToolCallDelta = {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type ToolCallAccumulator = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type NormalizedToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type SseConsumeResult = {
  content: string;
  toolCalls: NormalizedToolCall[];
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
  }>;
};

type ChatCompletionBody = Record<string, unknown> & {
  model?: string;
  tools?: unknown[];
  temperature?: number;
  top_p?: number;
  max_completion_tokens?: number;
  max_tokens?: number;
};

type ChatResult = string | {
  content: string;
  toolCalls: unknown[];
  tool_calls: unknown[];
};

/**
 * OpenAI 兼容第三方网关客户端（NewAPI / CherryIN / 自建反代等）。
 *
 * 与官方客户端分工：
 * - openai_llm → OpenAILLMClient（OpenAI 官方 Chat Completions）
 * - openai_compat_llm → 本类（第三方 OpenAI 形态兼容）
 * - 各厂商官方 builtin（deepseek / volcengine / anthropic …）独立 *LLMClient，按各自文档 buildBody
 */
export default class OpenAICompatibleLLMClient {
  config: LlmClientConfig;
  endpoint: string;
  _timeout = 360000;

  constructor(config: LlmClientConfig = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  normalizeEndpoint(config: LlmClientConfig) {
    return buildOpenAICompatEndpoint(config, {
      defaultPath: '/chat/completions',
      label: 'openai_compat',
    });
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  buildHeaders(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };

    if (this.config.apiKey) {
      const mode = String(this.config.authMode || 'bearer').toLowerCase();
      const apiKey = String(this.config.apiKey).trim();
      if (mode === 'api-key') {
        headers['api-key'] = apiKey;
      } else if (mode === 'header') {
        const name = String(this.config.authHeaderName ?? '').trim();
        if (!name) throw new Error('openai_compat: authMode=header 时必须提供 authHeaderName');
        headers[name] = apiKey;
      } else {
        headers.Authorization = `Bearer ${apiKey}`;
      }
    }

    if (this.config.headers) Object.assign(headers, this.config.headers);
    return headers;
  }

  async transformMessages(messages: ChatMessage[]) {
    return await transformMessagesWithVision(messages, this.config, { mode: 'openai' });
  }

  buildBody(messages: ChatMessage[], overrides: LlmOverrides = {}) {
    const defaultModel = this.config.model || this.config.chatModel;
    const body = buildOpenAIChatCompletionsBody(messages, this.config, overrides, defaultModel);
    applyOpenAITools(body, this.config, overrides);
    return body;
  }

  async _prepareMessages(messages: ChatMessage[]) {
    const transformed = await this.transformMessages(messages);
    await ensureMessagesImagesDataUrl(transformed, { timeoutMs: this.timeout });
    const cleaned = cleanupMessages(transformed);
    // 可选：部分上游兼容网关不接受历史 tool/tool_calls 回合。
    // 这里用“配置开关”而非写死某个模型，保证行为可控且不影响其他平台的标准调用。
    if (this.config.stripToolTraces !== true) return cleaned;
    return cleaned
      .filter(m => m?.role && m.role !== 'tool')
      .map(m => {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          const hasText = typeof m.content === 'string' ? m.content.trim().length > 0 : Boolean(m.content);
          return hasText ? { role: 'assistant', content: m.content } : null;
        }
        const out = { ...m };
        if (out.role === 'assistant') delete out.tool_calls;
        return out;
      })
      .filter(Boolean) as ChatMessage[];
  }

  _normalizeToolCall(toolCall: ToolCallAccumulator, index: number): NormalizedToolCall {
    const normalized: NormalizedToolCall = {
      id: toolCall?.id,
      type: toolCall?.type || 'function',
      function: {
        name: toolCall?.function?.name || '',
        arguments: toolCall?.function?.arguments || ''
      }
    };
    if (!normalized.id || typeof normalized.id !== 'string') {
      normalized.id = `call_${index}_${(normalized.function.name || 'tool').replace(/\W/g, '_')}`;
    }
    return normalized;
  }

  _buildRequestOptions(messages: ChatMessage[], overrides: LlmOverrides = {}, stream = false) {
    overrides.stream = stream;
    const body = this.buildBody(messages, overrides) as ChatCompletionBody;
    const bodyStr = JSON.stringify(body);

    // 构建日志信息（只显示有值的字段）
    const logParts = [
      `stream=${stream}`,
      `endpoint=${this.endpoint}`,
      `model=${body?.model || '<empty>'}`,
      body?.tools && body.tools.length > 0 ? `tools=${body.tools.length}` : null,
      body?.temperature !== undefined ? `temperature=${body.temperature}` : null,
      body?.top_p !== undefined ? `top_p=${body.top_p}` : null,
      body?.max_completion_tokens !== undefined ? `max_completion_tokens=${body.max_completion_tokens}` : null,
      body?.max_tokens !== undefined ? `max_tokens=${body.max_tokens}` : null,
      `bodyLength=${bodyStr.length}`
    ].filter(Boolean).join(', ');

    RuntimeUtil.makeLog('debug', `[OpenAICompatibleLLMClient] 构建请求: ${logParts}`, 'LLMFactory');

    return buildFetchOptionsWithProxy(this.config as Parameters<typeof buildFetchOptionsWithProxy>[0], {
      method: 'POST',
      headers: this.buildHeaders(overrides.headers),
      body: bodyStr,
      signal: AbortSignal.timeout(this.timeout)
    }) as RequestInit;
  }

  async _fetchRound(messages: ChatMessage[], overrides: LlmOverrides = {}, stream = false) {
    const resp = await fetch(this.endpoint, this._buildRequestOptions(messages, overrides, stream));
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const tag = stream ? '流式请求失败' : '请求失败';
      throw createLlmHttpError(
        `openai_compat ${tag}: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers as { get?: (name: string) => string | null } }
      );
    }
    if (stream && !resp.body) {
      RuntimeUtil.makeLog(
        'warn',
        '[OpenAICompatibleLLMClient] 流式请求失败：resp.ok 但 body 为空',
        'LLMFactory'
      );
      throw new Error('openai_compat 流式请求失败: 响应 body 为空');
    }

    if (stream) {
      const contentType = (resp.headers?.get?.('content-type') || '').toLowerCase();
      // 某些上游在 HTTP 200 时仍返回 JSON 错误体（如 {"status":"435","msg":"Model not support"}），
      // 这会导致 SSE 解析拿不到任何 data 事件，表现为“空流”。这里显式检测并抛出可读错误。
      if (contentType && !contentType.includes('text/event-stream')) {
        const text = await resp.text().catch(() => '');
        RuntimeUtil.makeLog(
          'warn',
          `[OpenAICompatibleLLMClient] 期望SSE但收到非SSE响应: content-type=${contentType}, bodyPreview="${String(text)
            .slice(0, 300)
            .replace(/\s+/g, ' ')}"`,
          'LLMFactory'
        );
        throw new Error(
          `openai_compat 流式响应不是SSE: content-type=${contentType}${text ? ` | body=${text}` : ''}`
        );
      }
    }

    RuntimeUtil.makeLog(
      'info',
      `[OpenAICompatibleLLMClient] _fetchRound 成功: stream=${stream}, status=${resp.status}, url=${resp.url || this.endpoint}`,
      'LLMFactory'
    );
    return resp;
  }

  async _consumeSSEWithToolCalls(resp: Response, onDelta: OnDeltaCallback, _options: LlmOverrides = {}) {
    const toolCallsMap = new Map<number, ToolCallAccumulator>();
    const result: SseConsumeResult = { content: '', toolCalls: [] };
    let sseEventCount = 0;
    let sseDataChars = 0;
    let deltaContentChars = 0;

    for await (const { data } of iterateSSE(resp as Parameters<typeof iterateSSE>[0])) {
      sseEventCount += 1;
      sseDataChars += data?.length || 0;

      try {
        const json = JSON.parse(data) as ChatCompletionResponse;
        const delta = json?.choices?.[0]?.delta;

        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          result.content += delta.content;
          deltaContentChars += delta.content.length;
          if (typeof onDelta === 'function') onDelta(delta.content);
        }

        if (Array.isArray(delta?.tool_calls)) {
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

            const item = toolCallsMap.get(index)!;
            if (tc.id) item.id = tc.id;
            if (tc.function?.name) item.function.name = tc.function.name;
            if (tc.function?.arguments) item.function.arguments += tc.function.arguments;
          }

          // 透传 tool_calls，由客户端处理下游工具（工厂单次补全，不服务端执行）
          if (typeof onDelta === 'function' && delta.tool_calls.length > 0) {
            onDelta('', { tool_calls: delta.tool_calls });
          }
        }
      } catch (e) {
        RuntimeUtil.makeLog('warn', `[OpenAICompatibleLLMClient] SSE JSON解析失败: ${normalizeError(e).message}`, 'LLMFactory');
      }
    }

    if (toolCallsMap.size > 0) {
      const sortedIndices = Array.from(toolCallsMap.keys()).sort((a, b) => a - b);
      result.toolCalls = sortedIndices.map((idx, i) => this._normalizeToolCall(toolCallsMap.get(idx)!, i));
      RuntimeUtil.makeLog('info', `[OpenAICompatibleLLMClient] 收集到${result.toolCalls.length}个工具调用`, 'LLMFactory');
    }

    RuntimeUtil.makeLog(
      'info',
      `[OpenAICompatibleLLMClient] SSE 消费完成: events=${sseEventCount}, sseDataChars=${sseDataChars}, deltaContentChars=${deltaContentChars}`,
      'LLMFactory'
    );

    return result;
  }

  /**
   * 单次补全。MCP tool 环：@xrkseek/harness（AiWorkflow.callAI / /v1）。
   * 本客户端仅透传 tool_calls，不执行工具。
   */
  async chat(messages: ChatMessage[], overrides: LlmOverrides = {}): Promise<ChatResult> {
    const prepared = await this._prepareMessages(messages);
    const current = cleanupMessages([...prepared], { ensureUserFirst: false });
    const resp = await this._fetchRound(current, overrides, false);
    const json = (await resp.json()) as ChatCompletionResponse;
    logPromptCacheUsage(json?.usage, 'OpenAICompatible');
    const message = json?.choices?.[0]?.message;
    const content = message?.content || '';
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length) {
      RuntimeUtil.makeLog(
        'info',
        `[OpenAICompatibleLLMClient] 单次补全含 tool_calls×${toolCalls.length}（本客户端不执行工具）`,
        'LLMFactory',
      );
      return { content, toolCalls, tool_calls: toolCalls };
    }
    return content;
  }

  async chatStream(messages: ChatMessage[], onDelta: OnDeltaCallback, overrides: LlmOverrides = {}) {
    const prepared = await this._prepareMessages(messages);
    const current = cleanupMessages([...prepared], { ensureUserFirst: false });

    RuntimeUtil.makeLog(
      'info',
      `[OpenAICompatibleLLMClient] chatStream 开始: messages=${current.length}`,
      'LLMFactory'
    );

    const resp = await this._fetchRound(current, overrides, true);
    const result = await this._consumeSSEWithToolCalls(resp, onDelta, overrides);

    RuntimeUtil.makeLog(
      'info',
      `[OpenAICompatibleLLMClient] chatStream 结束`,
      'LLMFactory'
    );

    return result;
  }
}
