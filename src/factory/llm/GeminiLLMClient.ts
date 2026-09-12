import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { fetchAsBase64 } from '#utils/llm/image-utils.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';
import { createLlmHttpError } from '#utils/llm/llm-http-error.js';

type LlmClientConfig = Record<string, unknown> & {
  model?: string;
  chatModel?: string;
  baseUrl?: string;
  path?: string;
  apiKey?: string;
  authMode?: string;
  headers?: Record<string, string>;
  timeout?: number;
  temperature?: number;
  maxOutputTokens?: number;
  max_output_tokens?: number;
  maxTokens?: number;
  max_tokens?: number;
  topP?: number;
  top_p?: number;
  topK?: number;
  top_k?: number;
  extraBody?: Record<string, unknown>;
  proxy?: unknown;
};

type ChatMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

type LlmOverrides = Record<string, unknown> & {
  headers?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  max_output_tokens?: number;
  maxTokens?: number;
  max_tokens?: number;
  topP?: number;
  top_p?: number;
  topK?: number;
  top_k?: number;
  extraBody?: Record<string, unknown>;
};

type OnDeltaCallback = (chunk: string, meta?: Record<string, unknown>) => void;

type GeminiPart = { text?: string; inlineData?: { mimeType: string; data: string } };

type GeminiPayload = Record<string, unknown> & {
  contents: Array<{ role: string; parts: GeminiPart[] }>;
  generationConfig?: Record<string, unknown>;
  systemInstruction?: { parts: Array<{ text: string }> };
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

/**
 * Gemini ?? LLM ????Google Generative Language API?
 * ???https://ai.google.dev/api
 *
 * - baseUrl ?? `https://generativelanguage.googleapis.com`
 * - path ?? `/v1beta/models/{model}:generateContent`
 * - ????? `x-goog-api-key`?`authMode: query` ??? `?key=`
 * - ???`:streamGenerateContent?alt=sse`
 * - ????inlineData(base64)??? `transformMessagesWithVision` ???? OpenAI content
 * - MCP tools?Gemini function calling ????????????? enableTools=false?
 *
 * harness?`createLlmFromConfig` ? provider~/gemini/ ? `createGeminiAdapter`?
 * ??????? LLMFactory ?????
 */
export default class GeminiLLMClient {
  config: LlmClientConfig;
  endpoint: string;
  _timeout = 360000;

  constructor(config: LlmClientConfig = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = Number(config.timeout ?? 360000);
  }

  normalizeEndpoint(config: LlmClientConfig) {
    const base = (config.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    const model = encodeURIComponent(String(config.model || config.chatModel || ''));
    const path = (config.path || (model ? `/v1beta/models/${model}:generateContent` : '')).replace(/^\/?/, '/');
    if (!config.apiKey) {
      throw new Error('gemini: ??? apiKey');
    }
    if (!path) {
      throw new Error('gemini: ??? model/chatModel ? path');
    }
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  /** @returns {'header'|'query'} */
  authMode(): 'header' | 'query' {
    const mode = String(this.config.authMode || 'header').trim().toLowerCase();
    return mode === 'query' || mode === 'key' ? 'query' : 'header';
  }

  buildHeaders(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.authMode() === 'header' && this.config.apiKey) {
      headers['x-goog-api-key'] = String(this.config.apiKey).trim();
    }
    if (this.config.headers) Object.assign(headers, this.config.headers);
    return headers;
  }

  resolveUrl(url: string) {
    if (this.authMode() !== 'query') return url;
    const u = new URL(url);
    u.searchParams.set('key', String(this.config.apiKey).trim());
    return u.toString();
  }

  async transformMessages(messages: ChatMessage[]) {
    return await transformMessagesWithVision(messages, this.config, { mode: 'openai' });
  }

  async _toInlineData(url: unknown) {
    const raw = String(url ?? '').trim();
    if (!raw) return null;

    const info = await fetchAsBase64(raw, { timeoutMs: this.timeout });
    if (!info || !info.base64) return null;
    return { inlineData: { mimeType: info.mimeType || 'image/png', data: info.base64 } };
  }

  async buildGeminiPayload(messages: ChatMessage[], overrides: LlmOverrides = {}): Promise<GeminiPayload> {
    const systemTexts: string[] = [];
    const contents: Array<{ role: string; parts: GeminiPart[] }> = [];

    for (const m of messages ?? []) {
      const role = String(m.role ?? '').toLowerCase();
      if (role === 'system') {
        const text = (
          typeof m.content === 'string'
            ? m.content
            : ((m.content as { text?: string; content?: string } | null)?.text ??
              (m.content as { content?: string } | null)?.content ??
              '')
        ).toString();
        if (text) systemTexts.push(text);
        continue;
      }

      const parts: GeminiPart[] = [];
      if (typeof m.content === 'string') {
        const text = m.content.toString();
        if (text) parts.push({ text });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content as Array<{
          type?: string;
          text?: string;
          image_url?: { url?: string };
        }>) {
          if (p?.type === 'text' && p.text) {
            parts.push({ text: String(p.text) });
          } else if (p?.type === 'image_url' && p.image_url?.url) {
            const inlinePart = await this._toInlineData(p.image_url.url);
            if (inlinePart) {
              parts.push(inlinePart);
            } else {
              parts.push({ text: `[??:${String(p.image_url.url)}]` });
            }
          }
        }
      } else if (m.content && typeof m.content === 'object') {
        const c = m.content as { text?: string; content?: string };
        const text = (c.text ?? c.content ?? '').toString();
        if (text) parts.push({ text });
      }

      if (parts.length === 0) continue;
      contents.push({
        role: role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }

    const generationConfig: Record<string, unknown> = {};

    const temperature = overrides.temperature ?? this.config.temperature;
    if (temperature !== undefined) generationConfig.temperature = temperature;

    const maxOutputTokens =
      overrides.maxOutputTokens ??
      overrides.max_output_tokens ??
      overrides.maxTokens ??
      overrides.max_tokens ??
      this.config.maxOutputTokens ??
      this.config.max_output_tokens ??
      this.config.maxTokens ??
      this.config.max_tokens;
    if (maxOutputTokens !== undefined) generationConfig.maxOutputTokens = maxOutputTokens;

    const topP = overrides.topP ?? overrides.top_p ?? this.config.topP ?? this.config.top_p;
    if (topP !== undefined) generationConfig.topP = topP;

    const topK = overrides.topK ?? overrides.top_k ?? this.config.topK ?? this.config.top_k;
    if (topK !== undefined) generationConfig.topK = topK;

    const payload: GeminiPayload = {
      contents,
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    };

    if (systemTexts.length > 0) {
      payload.systemInstruction = { parts: [{ text: systemTexts.join('\n') }] };
    }

    if (this.config.extraBody && typeof this.config.extraBody === 'object') {
      Object.assign(payload, this.config.extraBody);
    }
    if (overrides.extraBody && typeof overrides.extraBody === 'object') {
      Object.assign(payload, overrides.extraBody);
    }

    return payload;
  }

  extractTextFromResponse(json: GeminiResponse | null | undefined) {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((p) => p?.text ?? '').join('');
  }

  async chat(messages: ChatMessage[], overrides: LlmOverrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    const resp = await fetch(
      this.resolveUrl(this.endpoint),
      buildFetchOptionsWithProxy(this.config as Parameters<typeof buildFetchOptionsWithProxy>[0], {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(await this.buildGeminiPayload(transformedMessages as ChatMessage[], overrides)),
        signal: AbortSignal.timeout(this.timeout),
      }) as RequestInit,
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw createLlmHttpError(
        `Gemini ????: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers as { get?: (name: string) => string | null } },
      );
    }

    const data = (await resp.json()) as GeminiResponse;
    return this.extractTextFromResponse(data);
  }

  async chatStream(messages: ChatMessage[], onDelta: OnDeltaCallback, overrides: LlmOverrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    const baseUrl = this.endpoint.replace(/:generateContent$/, ':streamGenerateContent');
    const url = new URL(this.resolveUrl(baseUrl));
    url.searchParams.set('alt', 'sse');

    const resp = await fetch(
      url.toString(),
      buildFetchOptionsWithProxy(this.config as Parameters<typeof buildFetchOptionsWithProxy>[0], {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(await this.buildGeminiPayload(transformedMessages as ChatMessage[], overrides)),
        signal: AbortSignal.timeout(this.timeout),
      }) as RequestInit,
    );

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw createLlmHttpError(
        `Gemini ??????: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers as { get?: (name: string) => string | null } },
      );
    }
    let emitted = '';
    for await (const { data } of iterateSSE(resp as Parameters<typeof iterateSSE>[0])) {
      if (!data) continue;
      try {
        const json = JSON.parse(data) as GeminiResponse;
        const full = this.extractTextFromResponse(json);
        if (full && full.startsWith(emitted)) {
          const delta = full.slice(emitted.length);
          if (delta && typeof onDelta === 'function') onDelta(delta);
          emitted = full;
        }
      } catch {
        // ignore malformed SSE chunk
      }
    }
  }
}
