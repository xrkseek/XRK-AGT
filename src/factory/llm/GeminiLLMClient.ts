// @ts-nocheck
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { fetchAsBase64 } from '#utils/llm/image-utils.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';
import { createLlmHttpError } from '#utils/llm/llm-http-error.js';

/**
 * Gemini 官方 LLM 客户端（Google Generative Language API）
 * 文档：https://ai.google.dev/api
 *
 * - baseUrl 默认 `https://generativelanguage.googleapis.com`
 * - path 默认 `/v1beta/models/{model}:generateContent`
 * - 认证：优先 `x-goog-api-key`；`authMode: query` 时退回 `?key=`
 * - 流式：`:streamGenerateContent?alt=sse`
 * - 多模态：inlineData(base64)；上游 `transformMessagesWithVision` 先统一为 OpenAI content
 * - MCP tools：Gemini function calling 协议不同，默认不注入（建议 enableTools=false）
 */
export default class GeminiLLMClient {
  _timeout = 360000;

  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    const model = encodeURIComponent(config.model || config.chatModel || '');
    const path = (config.path || (model ? `/v1beta/models/${model}:generateContent` : '')).replace(/^\/?/, '/');
    if (!config.apiKey) {
      throw new Error('gemini: 未配置 apiKey');
    }
    if (!path) {
      throw new Error('gemini: 未配置 model/chatModel 或 path');
    }
    return `${base}${path}`;
  }

  get timeout() {
    return this._timeout ?? 360000;
  }

  /** @returns {'header'|'query'} */
  authMode() {
    const mode = String(this.config.authMode || 'header').trim().toLowerCase();
    return mode === 'query' || mode === 'key' ? 'query' : 'header';
  }

  buildHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...extra
    };
    if (this.authMode() === 'header' && this.config.apiKey) {
      headers['x-goog-api-key'] = String(this.config.apiKey).trim();
    }
    if (this.config.headers) Object.assign(headers, this.config.headers);
    return headers;
  }

  resolveUrl(url) {
    if (this.authMode() !== 'query') return url;
    const u = new URL(url);
    u.searchParams.set('key', String(this.config.apiKey).trim());
    return u.toString();
  }

  async transformMessages(messages) {
    return await transformMessagesWithVision(messages, this.config, { mode: 'openai' });
  }

  async _toInlineData(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return null;

    const info = await fetchAsBase64(raw, { timeoutMs: this.timeout });
    if (!info || !info.base64) return null;
    return { inlineData: { mimeType: info.mimeType || 'image/png', data: info.base64 } };
  }

  async buildGeminiPayload(messages, overrides = {}) {
    const systemTexts = [];
    const contents = [];

    for (const m of messages ?? []) {
      const role = (m.role ?? '').toLowerCase();
      if (role === 'system') {
        const text = (typeof m.content === 'string' ? m.content : (m.content?.text ?? m.content?.content ?? '')).toString();
        if (text) systemTexts.push(text);
        continue;
      }

      const parts = [];
      if (typeof m.content === 'string') {
        const text = m.content.toString();
        if (text) parts.push({ text });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p?.type === 'text' && p.text) {
            parts.push({ text: String(p.text) });
          } else if (p?.type === 'image_url' && p.image_url?.url) {
            const inlinePart = await this._toInlineData(p.image_url.url);
            if (inlinePart) {
              parts.push(inlinePart);
            } else {
              parts.push({ text: `[图片:${String(p.image_url.url)}]` });
            }
          }
        }
      } else if (m.content && typeof m.content === 'object') {
        const text = (m.content.text ?? m.content.content ?? '').toString();
        if (text) parts.push({ text });
      }

      if (parts.length === 0) continue;
      contents.push({
        role: role === 'assistant' ? 'model' : 'user',
        parts
      });
    }

    const generationConfig = {};

    const temperature = overrides.temperature ?? this.config.temperature;
    if (temperature !== undefined) generationConfig.temperature = temperature;

    const maxOutputTokens =
      (overrides.maxOutputTokens ?? overrides.max_output_tokens ?? overrides.maxTokens ?? overrides.max_tokens) ??
      (this.config.maxOutputTokens ?? this.config.max_output_tokens ?? this.config.maxTokens ?? this.config.max_tokens);
    if (maxOutputTokens !== undefined) generationConfig.maxOutputTokens = maxOutputTokens;

    const topP = (overrides.topP ?? overrides.top_p ?? this.config.topP ?? this.config.top_p);
    if (topP !== undefined) generationConfig.topP = topP;

    const topK = (overrides.topK ?? overrides.top_k ?? this.config.topK ?? this.config.top_k);
    if (topK !== undefined) generationConfig.topK = topK;

    const payload = {
      contents,
      ...(Object.keys(generationConfig).length ? { generationConfig } : {})
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

  extractTextFromResponse(json) {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map(p => p?.text ?? '').join('');
  }

  async chat(messages, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    const resp = await fetch(
      this.resolveUrl(this.endpoint),
      buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(await this.buildGeminiPayload(transformedMessages, overrides)),
        signal: AbortSignal.timeout(this.timeout)
      })
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw createLlmHttpError(
        `Gemini 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers }
      );
    }

    const data = await resp.json();
    return this.extractTextFromResponse(data);
  }

  async chatStream(messages, onDelta, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    const baseUrl = this.endpoint.replace(/:generateContent$/, ':streamGenerateContent');
    const url = new URL(this.resolveUrl(baseUrl));
    url.searchParams.set('alt', 'sse');

    const resp = await fetch(
      url.toString(),
      buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(await this.buildGeminiPayload(transformedMessages, overrides)),
        signal: AbortSignal.timeout(this.timeout)
      })
    );

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw createLlmHttpError(
        `Gemini 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers }
      );
    }
    let emitted = '';
    for await (const { data } of iterateSSE(resp)) {
      if (!data) continue;
      try {
        const json = JSON.parse(data);
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
