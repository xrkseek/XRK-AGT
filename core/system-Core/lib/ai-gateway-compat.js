/**
 * 标准运营商网关兼容：OpenAI /v1 与 Anthropic Messages 形态转换。
 * 供 system-Core HTTP 业务层挂别名路由，不改 LLM 工厂内部协议。
 */
import LLMFactory from '#factory/llm/LLMFactory.js';
import { getDefaultProvider } from '#utils/http/ai-v3-utils.js';

export function listProviderModelIds() {
  const profiles = LLMFactory.listModelProfiles();
  const keys = profiles.map((p) => p.key).filter(Boolean);
  const fallback = getDefaultProvider();
  return keys.length ? keys : (fallback ? [fallback] : []);
}

export function buildOpenAIModelsPayload() {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: listProviderModelIds().map((id) => ({
      id,
      object: 'model',
      created: now,
      owned_by: 'xrk-agt'
    }))
  };
}

export function buildOpenAIModelPayload(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  const known = listProviderModelIds();
  if (!known.includes(id) && !LLMFactory.hasProvider(id)) return null;
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'xrk-agt'
  };
}

/** Anthropic content blocks / string → OpenAI message content */
function anthropicContentToOpenAI(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  const parts = [];
  let textAcc = '';
  for (const block of content) {
    const type = String(block?.type || '').toLowerCase();
    if (type === 'text' && typeof block.text === 'string') {
      textAcc += block.text;
      continue;
    }
    if (type === 'image' && block.source) {
      if (textAcc) {
        parts.push({ type: 'text', text: textAcc });
        textAcc = '';
      }
      const src = block.source;
      if (src.type === 'url' && src.url) {
        parts.push({ type: 'image_url', image_url: { url: String(src.url) } });
      } else if (src.type === 'base64' && src.data) {
        const media = src.media_type || 'image/png';
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${media};base64,${src.data}` }
        });
      }
      continue;
    }
    if (type === 'tool_use') {
      // 工具结果轮次在 OpenAI 侧用 tool role；此处仅忽略非文本块到 parts
      continue;
    }
    if (type === 'tool_result') {
      const out = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content ?? '');
      parts.push({ type: 'text', text: out });
    }
  }
  if (!parts.length) return textAcc;
  if (textAcc) parts.unshift({ type: 'text', text: textAcc });
  return parts;
}

/**
 * Anthropic Messages 请求体 → OpenAI Chat Completions 请求体（供现有 v3 handler 复用）
 */
export function anthropicMessagesToOpenAIBody(body = {}) {
  const messages = [];
  if (body.system != null) {
    const sys = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n')
        : String(body.system);
    if (sys.trim()) messages.push({ role: 'system', content: sys });
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    messages.push({
      role,
      content: anthropicContentToOpenAI(m?.content)
    });
  }

  const out = {
    model: body.model,
    messages,
    stream: Boolean(body.stream),
    max_tokens: body.max_tokens ?? body.maxTokens,
    temperature: body.temperature,
    top_p: body.top_p ?? body.topP,
    stop: body.stop_sequences || body.stop
  };

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => {
      if (t?.type === 'function' && t.function) return t;
      const name = t?.name || t?.function?.name;
      const description = t?.description || t?.function?.description || '';
      const parameters = t?.input_schema || t?.function?.parameters || { type: 'object', properties: {} };
      return {
        type: 'function',
        function: { name, description, parameters }
      };
    });
  }
  if (body.tool_choice != null) out.tool_choice = body.tool_choice;
  if (body.workflow != null) out.workflow = body.workflow;
  if (body.workspace != null) out.workspace = body.workspace;

  return out;
}

/** OpenAI chat.completion JSON → Anthropic message */
export function openAIChatToAnthropicMessage(completion, { model } = {}) {
  const choice = completion?.choices?.[0];
  const text = choice?.message?.content ?? '';
  const usage = completion?.usage || {};
  return {
    id: completion?.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model || completion?.model || 'unknown',
    content: [{ type: 'text', text: String(text || '') }],
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0
    }
  };
}

function mapFinishReason(reason) {
  const r = String(reason || 'stop').toLowerCase();
  if (r === 'length') return 'max_tokens';
  if (r === 'tool_calls' || r === 'function_call') return 'tool_use';
  return 'end_turn';
}

export function initAnthropicMessageSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function writeAnthropicEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

/**
 * 将 chatStream 文本增量写成 Anthropic Messages SSE
 */
export async function pipeAnthropicMessagesStream(res, {
  client,
  messages,
  overrides,
  id,
  model,
  runWrapped = (run) => run()
}) {
  writeAnthropicEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  writeAnthropicEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' }
  });

  let total = '';
  await runWrapped(async () => {
    await client.chatStream(messages, (delta) => {
      if (typeof delta !== 'string' || !delta) return;
      total += delta;
      writeAnthropicEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta }
      });
    }, overrides);
  });

  writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  writeAnthropicEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: Math.max(1, Math.ceil(total.length / 4)) }
  });
  writeAnthropicEvent(res, 'message_stop', { type: 'message_stop' });
  return total;
}
