import AnthropicLLMClient from './AnthropicLLMClient.js';
import { iterateSSE } from '#utils/llm/sse-utils.js';
import {
  applyAnthropicTools,
  ensureAnthropicMaxTokens,
  normalizeAnthropicMessages,
  normalizeAnthropicToolHistory,
} from '#utils/llm/anthropic-chat-utils.js';
import { createToolNameMapper } from '#utils/llm/tool-name-utils.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { logPromptCacheUsage } from '#utils/llm/prompt-cache-policy.js';

/**
 * Anthropic Messages 兼容网关（anthropic_compat_llm.providers）
 *
 * 官方 Claude API（platform.claude.com）：
 * - `POST https://api.anthropic.com/v1/messages`
 * - 静态密钥用 `x-api-key`；Workload Identity 短时令牌才用 `Authorization: Bearer`
 * - 必带 `anthropic-version`（默认 `2023-06-01`，由基类写入）
 *
 * 本类面向第三方 Messages 兼容反代：默认 `authMode=bearer`（网关常见）；
 * 若反代要求官方头，配置 `authMode: x-api-key`。工具环 / SSE 事件形状按 Messages API。
 */
export default class AnthropicCompatibleLLMClient extends AnthropicLLMClient {
  [key: string]: any;
  _toolNames = createToolNameMapper();

  constructor(config: any = {}) {
    super({
      authMode: 'bearer',
      ...config,
    });
  }

  normalizeEndpoint(config: any): string {
    let base = (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    let path = config.path || '/messages';
    if (!path.startsWith('/')) path = `/${path}`;

    if (path.startsWith('/v1/')) {
      return `${base.replace(/\/v1$/i, '')}${path}`;
    }
    if (path === '/messages' && !/\/v1$/i.test(base)) {
      base = `${base}/v1`;
    }
    return `${base}${path}`;
  }

  buildBody(messages: any, overrides: any = {}): any {
    const normalized = normalizeAnthropicToolHistory(
      normalizeAnthropicMessages(messages),
      this._toolNames,
    );
    const body = super.buildBody(normalized, overrides);
    applyAnthropicTools(body, this.config, overrides, this._toolNames);
    ensureAnthropicMaxTokens(body, this.config, overrides);
    return body;
  }

  async _finalizeImageBlocks(body: any): Promise<any> {
    return this._finalizeBodyImageBlocks(body);
  }

  async _postMessages(body: any, overrides: any = {}): Promise<any> {
    return this._postNativeBody(body, overrides);
  }

  _parseMessageToolUses(message: any = {}): { text: string; toolUses: any[] } {
    const toolUses: any[] = [];
    let text = '';
    for (const block of message.content ?? []) {
      if (block?.type === 'text') text += block.text ?? '';
      if (block?.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        });
      }
    }
    return { text, toolUses };
  }

  async _consumeAnthropicStream(resp: any, onDelta: any): Promise<any> {
    const result: any = { text: '', toolUses: [], stopReason: null };
    const toolDrafts = new Map<any, any>();

    for await (const { data } of iterateSSE(resp as any, { stopOnDone: false })) {
      if (!data) continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      const type = json?.type;
      if (type === 'content_block_delta') {
        const delta = json.delta || {};
        if (delta.type === 'text_delta' && delta.text) {
          result.text += delta.text;
          if (typeof onDelta === 'function') onDelta(delta.text);
        }
        if (delta.type === 'input_json_delta' && delta.partial_json != null) {
          const idx = json.index ?? 0;
          const draft = toolDrafts.get(idx) || { id: '', name: '', inputJson: '' };
          draft.inputJson += delta.partial_json;
          toolDrafts.set(idx, draft);
        }
      } else if (type === 'content_block_start') {
        const block = json.content_block || {};
        if (block.type === 'tool_use') {
          toolDrafts.set(json.index ?? toolDrafts.size, {
            id: block.id,
            name: block.name,
            inputJson: '',
          });
        }
      } else if (type === 'message_delta') {
        result.stopReason = json.delta?.stop_reason ?? result.stopReason;
      }
    }

    for (const draft of toolDrafts.values()) {
      let input: any = {};
      if (draft.inputJson) {
        try {
          input = JSON.parse(draft.inputJson);
        } catch {
          input = { raw: draft.inputJson };
        }
      }
      result.toolUses.push({ id: draft.id, name: draft.name, input });
    }

    return result;
  }

  async _completeOnce(
    initialMessages: any,
    overrides: any,
    { stream = false, onDelta }: any = {},
  ): Promise<any> {
    const currentMessages = normalizeAnthropicToolHistory(
      normalizeAnthropicMessages(await this.transformMessages(initialMessages)),
      this._toolNames,
    );

    const body = this.buildBody(currentMessages, overrides);
    body.stream = stream;

    const resp = await this._postMessages(body, overrides);

    if (stream) {
      const streamed = await this._consumeAnthropicStream(resp, onDelta);
      if (streamed.toolUses.length) {
        RuntimeUtil.makeLog(
          'warn',
          `[AnthropicCompatibleLLMClient] 单次补全含 tool_use×${streamed.toolUses.length}（本客户端不执行工具）`,
          'LLMFactory',
        );
      }
      return streamed.text;
    }

    const json: any = await resp.json();
    logPromptCacheUsage(json?.usage, 'AnthropicCompatible');
    const parsed = this._parseMessageToolUses(json);
    if (parsed.toolUses.length) {
      RuntimeUtil.makeLog(
        'warn',
        `[AnthropicCompatibleLLMClient] 单次补全含 tool_use×${parsed.toolUses.length}（本客户端不执行工具）`,
        'LLMFactory',
      );
    }
    if (parsed.text && typeof onDelta === 'function') onDelta(parsed.text);
    return parsed.text;
  }

  async chat(messages: any, overrides: any = {}): Promise<any> {
    return this._completeOnce(messages, overrides, { stream: false });
  }

  async chatStream(messages: any, onDelta: any, overrides: any = {}): Promise<void> {
    await this._completeOnce(messages, overrides, { stream: true, onDelta });
  }
}
