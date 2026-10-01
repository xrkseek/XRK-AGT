import { pick } from '#utils/llm/openai-chat-utils.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { ensureMessagesImagesDataUrl } from '#utils/llm/image-utils.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';
import { createLlmHttpError } from '#utils/llm/llm-http-error.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { normalizeError } from '#utils/normalize-error.js';

/** @see https://developers.openai.com/api/docs/guides/reasoning */
const OPENAI_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const OPENAI_REASONING_MODES = new Set(['standard', 'pro']);

type LlmClientConfig = Record<string, unknown> & {
  baseUrl?: string;
  path?: string;
  apiKey?: string;
  authMode?: string;
  authHeaderName?: string;
  headers?: Record<string, string>;
  model?: string;
  chatModel?: string;
  timeout?: number;
  tools?: unknown[];
  extraBody?: Record<string, unknown>;
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
};

type OnDeltaCallback = (chunk: string, meta?: Record<string, unknown>) => void;

type ResponsesBody = Record<string, unknown> & {
  model?: unknown;
  input?: unknown;
  stream?: boolean;
  temperature?: unknown;
  max_output_tokens?: unknown;
  top_p?: unknown;
  service_tier?: unknown;
  prompt_cache_key?: unknown;
  prompt_cache_retention?: unknown;
  safety_identifier?: unknown;
  instructions?: unknown;
  text?: Record<string, unknown>;
  previous_response_id?: unknown;
  max_tool_calls?: unknown;
  parallel_tool_calls?: unknown;
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning?: Record<string, unknown>;
  reasoning_effort?: unknown;
};

type BuildBodyOptions = {
  stream?: boolean;
  previousResponseId?: string;
};

type ContentPart = {
  type?: string;
  text?: string;
  image_url?: { url?: string };
  [key: string]: unknown;
};

type ResponsesInputMessage = {
  role: string;
  content: Array<Record<string, unknown>>;
};

type FunctionCallOutput = {
  type?: string;
  name?: string;
  call_id?: string;
  id?: string;
  arguments?: string | Record<string, unknown>;
};

type ResponsesApiResponse = {
  output_text?: string;
  output?: FunctionCallOutput[];
};

type ResponsesTool = Record<string, unknown> & {
  type?: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

type ChatResult = string | { content: string; tool_calls: NormalizedToolCall[] };

type NormalizedToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type ResponsesStreamEvent = Record<string, unknown> & {
  type?: string;
  delta?: string;
  item?: FunctionCallOutput;
  response?: Record<string, unknown>;
};

/**
 * Responses 协议用 `reasoning: { effort, mode }`，不是 Chat Completions 的顶层 `reasoning_effort`
 */
function applyOpenAIResponsesReasoning(
  body: ResponsesBody,
  overrides: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  const rawEffort = pick(overrides, config, ['reasoningEffort', 'reasoning_effort']);
  const rawMode = pick(overrides, config, ['reasoningMode', 'reasoning_mode']);
  const rawSummary = pick(overrides, config, ['reasoningSummary', 'reasoning_summary']);

  delete body.reasoning_effort;

  if (
    (rawEffort === undefined || rawEffort === null || rawEffort === '') &&
    (rawMode === undefined || rawMode === null || rawMode === '') &&
    (rawSummary === undefined || rawSummary === null || rawSummary === '')
  ) {
    return;
  }

  const prev = body.reasoning && typeof body.reasoning === 'object' ? { ...body.reasoning } : {};
  if (rawEffort !== undefined && rawEffort !== null && rawEffort !== '') {
    const effort = String(rawEffort).trim().toLowerCase();
    if (OPENAI_REASONING_EFFORTS.has(effort)) prev.effort = effort;
  }
  if (rawMode !== undefined && rawMode !== null && rawMode !== '') {
    const mode = String(rawMode).trim().toLowerCase();
    if (OPENAI_REASONING_MODES.has(mode)) prev.mode = mode;
  }
  if (rawSummary !== undefined && rawSummary !== null && rawSummary !== '') {
    prev.summary = rawSummary;
  }
  if (Object.keys(prev).length) body.reasoning = prev;
}

function isOpenAIResponsesBuiltInTool(tool: ResponsesTool) {
  const type = String(tool?.type || '').trim();
  return type === 'web_search' || type === 'web_search_preview' || type === 'file_search' || type === 'code_interpreter' || type === 'computer_use_preview' || type === 'image_generation';
}

function normalizeInputPart(part: ContentPart) {
  if (part.type === 'text') {
    return { type: 'input_text', text: String(part.text || '') };
  }
  if (part.type === 'image_url' && part.image_url?.url) {
    return { type: 'input_image', image_url: String(part.image_url.url) };
  }
  return part;
}

function toResponsesInput(messages: ChatMessage[] = []): ResponsesInputMessage[] {
  return messages.map((m) => ({
    role: m.role || 'user',
    content: Array.isArray(m.content)
      ? m.content.map((p) => normalizeInputPart(p as ContentPart))
      : typeof m.content === 'string'
        ? [{ type: 'input_text', text: m.content }]
        : [{ type: 'input_text', text: (m.content as { text?: string } | null | undefined)?.text || '' }]
  }));
}

function extractResponsesText(resp: ResponsesApiResponse) {
  if (typeof resp?.output_text === 'string' && resp.output_text) return resp.output_text;
  const outputs = Array.isArray(resp?.output) ? resp.output : [];
  const chunks: string[] = [];

  for (const item of outputs) {
    const content = Array.isArray((item as { content?: Array<{ text?: string }> }).content)
      ? (item as { content: Array<{ text?: string }> }).content
      : [];
    for (const c of content) {
      if (typeof c?.text === 'string' && c.text) chunks.push(c.text);
    }
  }

  return chunks.join('');
}

function extractFunctionCalls(resp: ResponsesApiResponse): FunctionCallOutput[] {
  const outputs = Array.isArray(resp.output) ? resp.output : [];
  return outputs.filter((item) => item.type === 'function_call' && item.name);
}

function functionCallsToToolCalls(functionCalls: FunctionCallOutput[] = []): NormalizedToolCall[] {
  return functionCalls.map((fc, idx) => ({
    id: fc.call_id || fc.id || `call_${idx}_${String(fc.name || 'tool').replace(/\W/g, '_')}`,
    type: 'function',
    function: {
      name: String(fc.name || ''),
      arguments: typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments || {})
    }
  }));
}

export default class OpenAIResponsesCompatibleLLMClient {
  config: LlmClientConfig;
  endpoint: string;
  _timeout = 360000;

  constructor(config: LlmClientConfig = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  normalizeEndpoint(config: LlmClientConfig) {
    const base = (config.baseUrl ?? '').replace(/\/+$/, '');
    const path = (config.path || '/v1/responses').replace(/^\/?/, '/');
    if (!base) {
      throw new Error('openai_responses_compat: 未配置 baseUrl（Responses 兼容接口地址）');
    }
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  buildHeaders(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra
    };

    if (this.config.apiKey) {
      const mode = String(this.config.authMode || 'bearer').toLowerCase();
      const apiKey = String(this.config.apiKey).trim();
      if (mode === 'api-key') {
        headers['api-key'] = apiKey;
      } else if (mode === 'header') {
        const name = String(this.config.authHeaderName ?? '').trim();
        if (!name) throw new Error('openai_responses_compat: authMode=header 时必须提供 authHeaderName');
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

  buildBody(input: unknown, overrides: LlmOverrides = {}, { stream = false, previousResponseId }: BuildBodyOptions = {}) {
    const body: ResponsesBody = {
      model: pick(overrides, this.config, ['model', 'chatModel']),
      input,
      stream
    };

    const temperature = pick(overrides, this.config, ['temperature']);
    if (temperature !== undefined) body.temperature = temperature;

    const maxTokens = pick(overrides, this.config, ['maxOutputTokens', 'max_output_tokens', 'maxTokens', 'max_tokens', 'maxCompletionTokens']);
    if (maxTokens !== undefined) body.max_output_tokens = maxTokens;

    const topP = pick(overrides, this.config, ['topP', 'top_p']);
    if (topP !== undefined) body.top_p = topP;

    const serviceTier = pick(overrides, this.config, ['service_tier', 'serviceTier']);
    if (serviceTier !== undefined) body.service_tier = serviceTier;

    const promptCacheKey = pick(overrides, this.config, ['prompt_cache_key', 'promptCacheKey']);
    if (promptCacheKey !== undefined) body.prompt_cache_key = promptCacheKey;

    const promptCacheRetention = pick(overrides, this.config, ['prompt_cache_retention', 'promptCacheRetention']);
    if (promptCacheRetention !== undefined) body.prompt_cache_retention = promptCacheRetention;

    const safetyIdentifier = pick(overrides, this.config, ['safety_identifier', 'safetyIdentifier']);
    if (safetyIdentifier !== undefined) body.safety_identifier = safetyIdentifier;

    const instructions = pick(overrides, this.config, ['instructions']);
    if (instructions !== undefined) body.instructions = instructions;

    const textFormat = pick(overrides, this.config, ['text', 'text_format', 'textFormat']);
    if (textFormat && typeof textFormat === 'object') {
      const tf = textFormat as Record<string, unknown>;
      body.text = tf.format ? tf as Record<string, unknown> : { format: tf };
    }

    const responseFormat = pick(overrides, this.config, ['response_format', 'responseFormat']);
    if (!body.text && responseFormat && typeof responseFormat === 'object') {
      body.text = { format: responseFormat as Record<string, unknown> };
    }

    const verbosity = pick(overrides, this.config, ['verbosity']);
    if (verbosity !== undefined) {
      body.text = body.text && typeof body.text === 'object' ? body.text : {};
      body.text.verbosity = verbosity;
    }

    if (previousResponseId) body.previous_response_id = previousResponseId;

    const maxToolCalls = pick(overrides, this.config, ['max_tool_calls', 'maxToolCalls']);
    if (maxToolCalls !== undefined) body.max_tool_calls = maxToolCalls;

    const parallelToolCalls = pick(overrides, this.config, ['parallel_tool_calls', 'parallelToolCalls']);
    if (parallelToolCalls !== undefined) body.parallel_tool_calls = parallelToolCalls;

    const tools = this.buildTools(overrides);
    if (Array.isArray(tools)) body.tools = tools;

    const toolChoice = pick(overrides, this.config, ['tool_choice', 'toolChoice']);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;

    // Responses API：reasoning.effort / reasoning.mode（非 Chat Completions 的 reasoning_effort）
    // @see https://developers.openai.com/api/docs/guides/reasoning
    applyOpenAIResponsesReasoning(body, overrides, this.config);

    const extraBody = pick(overrides, this.config, ['extraBody']);
    if (this.config.extraBody && typeof this.config.extraBody === 'object') Object.assign(body, this.config.extraBody);
    if (extraBody && typeof extraBody === 'object') Object.assign(body, extraBody as Record<string, unknown>);

    // extraBody 若误带顶层 reasoning_effort，归一到 reasoning.effort
    if (body.reasoning_effort != null && body.reasoning_effort !== '') {
      const prev = body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : {};
      if (prev.effort === undefined) {
        body.reasoning = { ...prev, effort: String(body.reasoning_effort).trim().toLowerCase() };
      }
      delete body.reasoning_effort;
    }

    return body;
  }

  buildTools(overrides: LlmOverrides = {}): unknown[] | undefined {
    if (Object.hasOwn(overrides, 'tools')) {
      return Array.isArray(overrides.tools) ? overrides.tools : undefined;
    }

    const customTools = Array.isArray(this.config.tools) ? this.config.tools : [];
    const merged = customTools
      .map((tool) => {
        if (!tool || typeof tool !== 'object') return null;
        const t = tool as ResponsesTool;
        if (isOpenAIResponsesBuiltInTool(t)) return t;

        if (t.type === 'function' && t.function?.name) {
          return {
            type: 'function',
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters || { type: 'object', properties: {}, required: [] }
          };
        }

        if (t.type === 'function' && t.name) {
          return {
            type: 'function',
            name: t.name,
            description: t.description || '',
            parameters: t.parameters || { type: 'object', properties: {}, required: [] }
          };
        }

        return null;
      })
      .filter(Boolean);

    return merged.length ? merged : undefined;
  }

  async requestResponses(input: unknown, overrides: LlmOverrides = {}, opts: BuildBodyOptions = {}) {
    const body = this.buildBody(input, overrides, opts);
    const resp = await fetch(
      this.endpoint,
      buildFetchOptionsWithProxy(this.config as Parameters<typeof buildFetchOptionsWithProxy>[0], {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout)
      }) as RequestInit
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw createLlmHttpError(
        `openai_responses_compat 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers as { get?: (name: string) => string | null } }
      );
    }

    return resp;
  }

  async chat(messages: ChatMessage[], overrides: LlmOverrides = {}): Promise<ChatResult> {
    const transformed = await this.transformMessages(messages);
    await ensureMessagesImagesDataUrl(transformed, { timeoutMs: this.timeout });

    const input = toResponsesInput(transformed);
    const resp = await this.requestResponses(input, overrides, { stream: false });
    const json = (await resp.json()) as ResponsesApiResponse;
    const text = extractResponsesText(json);
    const functionCalls = extractFunctionCalls(json);

    if (functionCalls.length) {
      RuntimeUtil.makeLog(
        'warn',
        `[OpenAIResponsesCompatibleLLMClient] 单次补全含 function_call×${functionCalls.length}（本客户端不执行工具）`,
        'LLMFactory',
      );
      return {
        content: text,
        tool_calls: functionCallsToToolCalls(functionCalls),
      };
    }
    return text;
  }

  /**
   * 消费一轮 Responses SSE：文本/推理 delta + 完成后的 response 对象。
   * @returns response.completed 上的 response，或 null
   */
  async consumeResponsesStream(resp: Response, onDelta: OnDeltaCallback, _overrides: LlmOverrides = {}) {
    if (!resp.body) {
      throw new Error('openai_responses_compat 流式请求失败: 响应体为空');
    }

    let completed: Record<string, unknown> | null = null;

    for await (const { data } of iterateSSE(resp as Parameters<typeof iterateSSE>[0])) {
      try {
        const evt = JSON.parse(data) as ResponsesStreamEvent;
        const type = evt?.type;

        if (type === 'response.output_text.delta' && typeof evt.delta === 'string' && evt.delta) {
          if (typeof onDelta === 'function') onDelta(evt.delta);
        }

        if (
          (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta')
          && typeof evt.delta === 'string'
          && evt.delta
        ) {
          if (typeof onDelta === 'function') onDelta('', { reasoning_content: evt.delta });
        }

        if (type === 'response.output_item.done' && evt.item?.type === 'function_call') {
          if (typeof onDelta === 'function') {
            onDelta('', {
              tool_calls: [{
                id: evt.item.call_id || evt.item.id,
                type: 'function',
                function: {
                  name: evt.item.name || '',
                  arguments: typeof evt.item.arguments === 'string'
                    ? evt.item.arguments
                    : JSON.stringify(evt.item.arguments || {}),
                },
              }],
            });
          }
        }

        if (type === 'response.completed' && evt.response) {
          completed = evt.response;
        }
      } catch (e) {
        RuntimeUtil.makeLog('warn', `[OpenAIResponsesCompatibleLLMClient] SSE JSON解析失败: ${normalizeError(e).message}`, 'LLMFactory');
      }
    }

    return completed;
  }

  async chatStream(messages: ChatMessage[], onDelta: OnDeltaCallback, overrides: LlmOverrides = {}) {
    const transformed = await this.transformMessages(messages);
    await ensureMessagesImagesDataUrl(transformed, { timeoutMs: this.timeout });

    const input = toResponsesInput(transformed);
    const resp = await this.requestResponses(input, overrides, { stream: true });
    await this.consumeResponsesStream(resp, onDelta, overrides);
  }
}
