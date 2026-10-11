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

type LlmClientConfig = Record<string, unknown> & {
  baseUrl?: string;
  path?: string;
  authMode?: string;
  timeout?: number;
};

type ChatMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

type LlmOverrides = Record<string, unknown> & {
  headers?: Record<string, string>;
};

type OnDeltaCallback = (chunk: string, meta?: Record<string, unknown>) => void;

type ToolUse = {
  id?: string;
  name?: string;
  input?: unknown;
};

type ToolDraft = {
  id?: string;
  name?: string;
  inputJson: string;
};

type StreamResult = {
  text: string;
  toolUses: ToolUse[];
  stopReason: string | null;
};

type AnthropicMessageJson = {
  usage?: unknown;
  content?: Array<{
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
};

type CompleteOnceOptions = {
  stream?: boolean;
  onDelta?: OnDeltaCallback;
};

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
  _toolNames = createToolNameMapper();

  constructor(config: LlmClientConfig = {}) {
    super({
      authMode: 'bearer',
      ...config,
    });
  }

  normalizeEndpoint(config: LlmClientConfig): string {
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

  buildBody(messages: ChatMessage[], overrides: LlmOverrides = {}) {
    const normalized = normalizeAnthropicToolHistory(
      normalizeAnthropicMessages(messages),
      this._toolNames,
    );
    const body = super.buildBody(normalized as ChatMessage[], overrides);
    applyAnthropicTools(body, this.config, overrides, this._toolNames);
    ensureAnthropicMaxTokens(body, this.config, overrides);
    return body;
  }

  async _finalizeImageBlocks(body: Parameters<AnthropicLLMClient['_finalizeBodyImageBlocks']>[0]) {
    return this._finalizeBodyImageBlocks(body);
  }

  async _postMessages(body: Parameters<AnthropicLLMClient['_postNativeBody']>[0], overrides: LlmOverrides = {}) {
    return this._postNativeBody(body, overrides);
  }

  _parseMessageToolUses(message: AnthropicMessageJson = {}): { text: string; toolUses: ToolUse[] } {
    const toolUses: ToolUse[] = [];
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

  async _consumeAnthropicStream(resp: Response, onDelta?: OnDeltaCallback): Promise<StreamResult> {
    const result: StreamResult = { text: '', toolUses: [], stopReason: null };
    const toolDrafts = new Map<number, ToolDraft>();

    for await (const { data } of iterateSSE(resp as Parameters<typeof iterateSSE>[0], { stopOnDone: false })) {
      if (!data) continue;
      let json: {
        type?: string;
        index?: number;
        delta?: {
          type?: string;
          text?: string;
          partial_json?: string;
          stop_reason?: string;
        };
        content_block?: {
          type?: string;
          id?: string;
          name?: string;
        };
      };
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
      let input: unknown = {};
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
    initialMessages: ChatMessage[],
    overrides: LlmOverrides,
    { stream = false, onDelta }: CompleteOnceOptions = {},
  ): Promise<string> {
    const currentMessages = normalizeAnthropicToolHistory(
      normalizeAnthropicMessages(await this.transformMessages(initialMessages)),
      this._toolNames,
    );

    const body = this.buildBody(currentMessages as ChatMessage[], overrides);
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

    const json = (await resp.json()) as AnthropicMessageJson;
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

  async chat(messages: ChatMessage[], overrides: LlmOverrides = {}): Promise<string> {
    return this._completeOnce(messages, overrides, { stream: false });
  }

  async chatStream(messages: ChatMessage[], onDelta: OnDeltaCallback, overrides: LlmOverrides = {}): Promise<void> {
    await this._completeOnce(messages, overrides, { stream: true, onDelta });
  }
}
