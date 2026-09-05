// @ts-nocheck
import { transformMessagesWithVision } from '#utils/llm/message-transform.js';
import { buildFetchOptionsWithProxy } from '#utils/llm/proxy-utils.js';
import { fetchAsBase64 } from '#utils/llm/image-utils.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';
import { ensureAnthropicMaxTokens, normalizeAnthropicMessages } from '#utils/llm/anthropic-chat-utils.js';
import { applyAnthropicThinking } from '#utils/llm/reasoning-budget.js';
import { logPromptCacheUsage } from '#utils/llm/prompt-cache-policy.js';

/**
 * Anthropic 官方 Messages API 客户端
 * @see https://platform.claude.com/docs/en/api/overview
 * @see https://platform.claude.com/docs/en/build-with-claude/thinking
 *
 * - 端点：`POST {baseUrl}/messages`（默认 `https://api.anthropic.com/v1/messages`）
 * - 静态密钥：`x-api-key`（默认）；WIF 短时令牌：`authMode: bearer` → `Authorization: Bearer`
 * - 必带：`anthropic-version`（默认 `2023-06-01`）、`content-type: application/json`
 * - 思考：`thinkingType=adaptive` + `reasoningEffort`→`output_config.effort`（4.6+）；旧模型用 `enabled`+budget_tokens
 */
export default class AnthropicLLMClient {
  _timeout = 360000;

  constructor(config = {}) {
    this.config = config;
    this.endpoint = this.normalizeEndpoint(config);
    this._timeout = config.timeout ?? 360000;
  }

  normalizeEndpoint(config) {
    const base = (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    const path = (config.path || '/messages').replace(/^\/?/, '/');
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
      const apiKey = String(this.config.apiKey).trim();
      const mode = String(this.config.authMode || 'x-api-key').toLowerCase();
      if (mode === 'bearer') {
        headers.Authorization = `Bearer ${apiKey}`;
      } else if (mode === 'header') {
        const name = String(this.config.authHeaderName ?? '').trim();
        if (!name) throw new Error('Anthropic: authMode=header 时必须提供 authHeaderName');
        headers[name] = apiKey;
      } else {
        headers['x-api-key'] = apiKey;
      }
    }

    // Anthropic 要求 anthropic-version（官方 overview：必填）
    headers['anthropic-version'] = String(this.config.anthropicVersion || '2023-06-01');

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  async transformMessages(messages) {
    // 统一为 OpenAI 风格多模态 content（text + image_url），再转换为 Anthropic 的 content blocks
    return await transformMessagesWithVision(messages, this.config, { mode: 'openai' });
  }

  async _toAnthropicImageBlock(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return null;

    const info = await fetchAsBase64(raw, { timeoutMs: this.timeout });
    if (!info || !info.base64) return null;

    const block = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: info.mimeType || 'image/png',
        data: info.base64
      }
    };
    return block;
  }

  /**
   * OpenAI-like messages -> Anthropic messages
   * - system: 单独提取为 system 字符串
   * - user/assistant: messages[{role, content}]
   */
  buildBody(messages, overrides = {}) {
    const systemTexts = [];
    const anthMessages = [];

    for (const m of messages ?? []) {
      const role = (m.role ?? '').toLowerCase();
      if (role === 'system') {
        const text = (typeof m.content === 'string' ? m.content : (m.content?.text ?? m.content?.content ?? '')).toString();
        if (text) systemTexts.push(text);
        continue;
      }

      const blocks = [];
      if (typeof m.content === 'string') {
        const text = m.content.toString();
        if (text) blocks.push({ type: 'text', text });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p?.type === 'text' && p.text) {
            blocks.push({ type: 'text', text: String(p.text) });
          } else if (p?.type === 'tool_use' && p.id && p.name) {
            blocks.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} });
          } else if (p?.type === 'tool_result' && p.tool_use_id) {
            blocks.push({
              type: 'tool_result',
              tool_use_id: p.tool_use_id,
              content: String(p.content ?? '')
            });
          } else if (p?.type === 'image' && p.source) {
            blocks.push(p);
          } else if (p?.type === 'image_url' && p.image_url?.url) {
            // 这里保持同步结构，实际转换在 chat/chatStream 前进行（buildBody 是纯构建函数）
            blocks.push({ type: '__image_url__', url: String(p.image_url.url) });
          }
        }
      } else if (m.content && typeof m.content === 'object') {
        const text = (m.content.text ?? m.content.content ?? '').toString();
        if (text) blocks.push({ type: 'text', text });
      }

      if (blocks.length === 0) continue;

      anthMessages.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: blocks
      });
    }

    const body = {
      model: overrides.model || overrides.chatModel || this.config.model || this.config.chatModel || 'claude-3-5-sonnet-latest',
      messages: anthMessages
    };

    const maxTokens = (overrides.maxTokens ?? overrides.max_tokens) ?? (this.config.maxTokens ?? this.config.max_tokens);
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    const temperature = overrides.temperature ?? this.config.temperature;
    if (temperature !== undefined) body.temperature = temperature;

    const topP = (overrides.topP ?? overrides.top_p) ?? (this.config.topP ?? this.config.top_p);
    if (topP !== undefined) body.top_p = topP;

    const topK = (overrides.topK ?? overrides.top_k) ?? (this.config.topK ?? this.config.top_k);
    if (topK !== undefined) body.top_k = topK;

    const stop = overrides.stop ?? this.config.stop;
    if (Array.isArray(stop) && stop.length > 0) body.stop_sequences = stop;

    const serviceTier = (overrides.anthropicServiceTier ?? overrides.serviceTier ?? overrides.service_tier)
      ?? (this.config.anthropicServiceTier ?? this.config.serviceTier ?? this.config.service_tier);
    if (serviceTier !== undefined && serviceTier !== '') body.service_tier = serviceTier;

    if (systemTexts.length > 0) {
      const useCache = overrides.anthropic_prompt_cache === true
        || this.config.anthropic_prompt_cache === true;
      if (useCache) {
        body.system = [{
          type: 'text',
          text: systemTexts.join('\n'),
          cache_control: { type: 'ephemeral' },
        }];
      } else {
        body.system = systemTexts.join('\n');
      }
    }

    applyAnthropicThinking(body, this.config, overrides);

    if (this.config.extraBody && typeof this.config.extraBody === 'object') {
      Object.assign(body, this.config.extraBody);
    }
    if (overrides.extraBody && typeof overrides.extraBody === 'object') {
      Object.assign(body, overrides.extraBody);
    }

    return body;
  }

  extractText(json) {
    // Anthropic: content: [{type:'text', text:'...'}]
    const parts = json?.content;
    if (!Array.isArray(parts)) return '';
    return parts.map(p => (p?.type === 'text' ? (p.text ?? '') : '')).join('');
  }

  async _finalizeBodyImageBlocks(body) {
    for (const msg of body.messages ?? []) {
      if (!Array.isArray(msg.content)) continue;
      const newBlocks = [];
      for (const b of msg.content) {
        if (b?.type === '__image_url__' && b.url) {
          const imgBlock = await this._toAnthropicImageBlock(b.url);
          if (imgBlock) newBlocks.push(imgBlock);
          else newBlocks.push({ type: 'text', text: `[图片:${String(b.url)}]` });
        } else if (b?.type === 'text') {
          newBlocks.push({ type: 'text', text: String(b.text ?? '') });
        } else if (b?.type === 'image' && b.source) {
          newBlocks.push(b);
        } else if (b?.type === 'tool_use' || b?.type === 'tool_result') {
          newBlocks.push(b);
        }
      }
      msg.content = newBlocks.filter((x) => x && (x.type === 'text' ? (x.text ?? '').toString().trim() : true));
    }
  }

  async _postNativeBody(body, overrides = {}) {
    await this._finalizeBodyImageBlocks(body);
    const resp = await fetch(
      this.endpoint,
      buildFetchOptionsWithProxy(this.config, {
        method: 'POST',
        headers: this.buildHeaders(overrides.headers),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout)
      })
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Anthropic 请求失败: ${resp.status} ${resp.statusText}${text ? ` | ${text}` : ''}`);
    }
    return resp;
  }

  /** 原生 Anthropic content blocks（含 image / tool_use），不经 OpenAI 多模态转换 */
  async chatNative(messages, overrides = {}) {
    const body = this.buildBody(normalizeAnthropicMessages(messages), overrides);
    ensureAnthropicMaxTokens(body, this.config, overrides);
    const resp = await this._postNativeBody(body, overrides);
    const data = await resp.json();
    logPromptCacheUsage(data?.usage, 'Anthropic');
    return this.extractText(data);
  }

  async chat(messages, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    const body = this.buildBody(transformedMessages, overrides);
    const resp = await this._postNativeBody(body, overrides);
    const data = await resp.json();
    logPromptCacheUsage(data?.usage, 'Anthropic');
    return this.extractText(data);
  }

  async chatStream(messages, onDelta, overrides = {}) {
    const transformedMessages = await this.transformMessages(messages);
    const body = this.buildBody(transformedMessages, overrides);
    body.stream = true;

    const resp = await this._postNativeBody(body, overrides);
    if (!resp.body) {
      throw new Error('Anthropic 流式响应无 body');
    }

    for await (const { data } of iterateSSE(resp, { stopOnDone: false })) {
      if (!data) continue;
      try {
        const json = JSON.parse(data);
        const type = json?.type;

        // Messages streaming：content_block_delta / content_block_start（text）
        let deltaText = '';
        if (type === 'content_block_delta') {
          const delta = json?.delta || {};
          if (delta.type === 'text_delta' || delta.text) {
            deltaText = delta.text ?? '';
          }
        } else if (type === 'content_block_start' && json?.content_block?.type === 'text') {
          deltaText = json.content_block.text ?? '';
        }

        if (deltaText && typeof onDelta === 'function') onDelta(deltaText);
      } catch {
        // ignore
      }
    }
  }
}

