// @ts-nocheck
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { fetchAsBase64 } from '#utils/llm/image-utils.js';
import { createLlmHttpError } from '#utils/llm/llm-http-error.js';

/**
 * Ollama Chat API（/api/chat）
 * @see https://docs.ollama.com/api/chat
 * think: boolean | "low" | "medium" | "high" | "max"
 */

const OLLAMA_THINK_LEVELS = new Set(['low', 'medium', 'high', 'max']);

/**
 * @param {Record<string, unknown>} overrides
 * @param {Record<string, unknown>} config
 * @returns {boolean|string|undefined}
 */
function resolveOllamaThink(overrides, config) {
  const raw =
    overrides.think ??
    config.think ??
    overrides.thinkingType ??
    overrides.thinking_type ??
    config.thinkingType ??
    config.thinking_type ??
    overrides.reasoningEffort ??
    overrides.reasoning_effort ??
    config.reasoningEffort ??
    config.reasoning_effort;
  if (raw === undefined || raw === null || raw === '') return;
  if (typeof raw === 'boolean') return raw;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true' || v === 'enabled') return true;
  if (v === 'false' || v === 'disabled' || v === 'none') return false;
  if (OLLAMA_THINK_LEVELS.has(v)) return v;
  if (v === 'minimal') return 'low';
  if (v === 'xhigh') return 'max';
  return true;
}

export default class OllamaCompatibleLLMClient {
  _timeout = 360000;

  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const path = (config.path || '/api/chat').replace(/^\/?/, '/');
    return `${base}${path}`;
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
      const mode = String(this.config.authMode || 'bearer').toLowerCase();
      const apiKey = String(this.config.apiKey).trim();
      if (mode === 'api-key') {
        headers['api-key'] = apiKey;
      } else if (mode === 'header') {
        const name = String(this.config.authHeaderName ?? '').trim();
        if (!name) throw new Error('ollama_compat: authMode=header 时必须提供 authHeaderName');
        headers[name] = apiKey;
      } else {
        headers.Authorization = `Bearer ${apiKey}`;
      }
    }

    if (this.config.headers) Object.assign(headers, this.config.headers);
    return headers;
  }

  async transformMessages(messages) {
    return await transformMessagesWithVision(messages, this.config, { mode: 'openai' });
  }

  async toOllamaMessages(messages = []) {
    const out = [];

    for (const m of messages) {
      const role = (m.role || 'user').toLowerCase();
      const item = {
        role: role === 'assistant' ? 'assistant' : role === 'system' ? 'system' : 'user',
        content: '',
        images: undefined
      };

      if (typeof m.content === 'string') {
        item.content = m.content;
      } else if (Array.isArray(m.content)) {
        const textParts = [];
        const imageParts = [];

        for (const p of m.content) {
          if (p?.type === 'text' && p.text) textParts.push(String(p.text));
          if (p?.type === 'image_url' && p.image_url?.url) {
            const info = await fetchAsBase64(String(p.image_url.url), { timeoutMs: this.timeout });
            if (info?.base64) imageParts.push(info.base64);
          }
        }

        item.content = textParts.join('\n');
        if (imageParts.length > 0) item.images = imageParts;
      } else if (m.content && typeof m.content === 'object') {
        item.content = String(m.content.text || m.content.content || '');
      }

      out.push(item);
    }

    return out;
  }

  buildBody(messages, overrides = {}, stream = false) {
    const model = overrides.model || overrides.chatModel || this.config.model || this.config.chatModel;
    const options = {
      temperature: overrides.temperature ?? this.config.temperature,
      top_p: overrides.topP ?? overrides.top_p ?? this.config.topP ?? this.config.top_p,
      num_predict: overrides.maxTokens ?? overrides.max_tokens ?? this.config.maxTokens ?? this.config.max_tokens,
      repeat_penalty: overrides.frequencyPenalty ?? overrides.frequency_penalty ?? this.config.frequencyPenalty ?? this.config.frequency_penalty
    };

    const stop = overrides.stop ?? this.config.stop;
    if (stop !== undefined) {
      options.stop = Array.isArray(stop) ? stop : [String(stop)];
    }

    Object.keys(options).forEach((k) => options[k] === undefined && delete options[k]);

    const body = {
      model,
      messages,
      stream,
      ...(Object.keys(options).length ? { options } : {})
    };

    const think = resolveOllamaThink(overrides, this.config);
    if (think !== undefined) body.think = think;

    if (this.config.extraBody && typeof this.config.extraBody === 'object') Object.assign(body, this.config.extraBody);
    if (overrides.extraBody && typeof overrides.extraBody === 'object') Object.assign(body, overrides.extraBody);

    return body;
  }

  async chat(messages, overrides = {}) {
    const transformed = await this.transformMessages(messages);
    const ollamaMessages = await this.toOllamaMessages(transformed);

    const resp = await fetch(
      this.endpoint,
      buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(this.buildBody(ollamaMessages, overrides, false)),
        signal: AbortSignal.timeout(this.timeout)
      })
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw createLlmHttpError(
        `ollama_compat 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers }
      );
    }

    const json = await resp.json();
    return json?.message?.content || '';
  }

  async chatStream(messages, onDelta, overrides = {}) {
    const transformed = await this.transformMessages(messages);
    const ollamaMessages = await this.toOllamaMessages(transformed);

    const resp = await fetch(
      this.endpoint,
      buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(this.buildBody(ollamaMessages, overrides, true)),
        signal: AbortSignal.timeout(this.timeout)
      })
    );

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      throw createLlmHttpError(
        `ollama_compat 流式请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`,
        { status: resp.status, headers: resp.headers }
      );
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        try {
          const evt = JSON.parse(text);
          const thinking = evt?.message?.thinking || '';
          if (thinking && typeof onDelta === 'function') onDelta('', { reasoning_content: thinking });
          const delta = evt?.message?.content || '';
          if (delta && typeof onDelta === 'function') onDelta(delta);
        } catch {
          /* ignore partial JSON lines */
        }
      }
    }

    if (buffer.trim()) {
      try {
        const evt = JSON.parse(buffer.trim());
        const thinking = evt?.message?.thinking || '';
        if (thinking && typeof onDelta === 'function') onDelta('', { reasoning_content: thinking });
        const delta = evt?.message?.content || '';
        if (delta && typeof onDelta === 'function') onDelta(delta);
      } catch {
        /* ignore */
      }
    }
  }
}
