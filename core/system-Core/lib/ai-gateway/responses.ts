// @ts-nocheck
/**
 * OpenAI Responses API（/v1/responses）↔ 内部 Chat Completions。
 *
 * 协议依据（2025–2026）：
 * - https://developers.openai.com/api/docs/api-reference/responses/create
 * - https://developers.openai.com/api/docs/guides/migrate-to-responses
 * - Azure / DeepSeek / 火山方舟等兼容实现同构：input / output / output_text / SSE 事件名
 *
 * 网关策略：不持久化 store（store 恒为 false）；previous_response_id 仅记录日志并忽略。
 * 内建 tools（web_search / file_search 等）透传字段但不在本机执行，由上游或客户端处理。
 */
import { initGatewaySSE, writeNamedSSE } from './sse.js';

const BUILTIN_TOOL_TYPES = new Set([
  'web_search',
  'web_search_preview',
  'file_search',
  'code_interpreter',
  'computer_use_preview',
  'image_generation',
  'mcp'
]);

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function contentPartToOpenAI(part) {
  if (part == null) return null;
  if (typeof part === 'string') return { type: 'text', text: part };

  const type = String(part.type || '').toLowerCase();
  if (type === 'input_text' || type === 'output_text' || type === 'text') {
    return { type: 'text', text: String(part.text || '') };
  }
  if (type === 'input_image' || type === 'image_url') {
    const url = part.image_url?.url || part.image_url || part.url;
    if (!url) return null;
    return { type: 'image_url', image_url: { url: String(url) } };
  }
  if (type === 'input_file' && (part.file_data || part.file_url || part.file_id)) {
    // Chat Completions 无通用 file part：降级为文本说明，避免丢上下文
    const hint = part.filename || part.file_id || 'file';
    return { type: 'text', text: `[file:${hint}]` };
  }
  if (typeof part.text === 'string') return { type: 'text', text: part.text };
  return null;
}

function normalizeMessageContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (typeof content === 'object' && typeof content.text === 'string') return content.text;
    return String(content);
  }
  const parts = [];
  for (const raw of content) {
    const p = contentPartToOpenAI(raw);
    if (p) parts.push(p);
  }
  if (!parts.length) return '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

/**
 * Responses `input` → Chat `messages`
 * input 可为：纯字符串 | Message/Item 数组
 */
export function responsesInputToMessages(input, { instructions } = {}) {
  const messages = [];
  if (instructions != null && String(instructions).trim()) {
    messages.push({ role: 'system', content: String(instructions) });
  }

  if (input == null || input === '') {
    return messages;
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  if (!Array.isArray(input)) {
    messages.push({ role: 'user', content: String(input) });
    return messages;
  }

  for (const item of input) {
    if (item == null) continue;

    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }

    const type = String(item.type || '').toLowerCase();

    // 易混：无 type 的 {role, content} 消息
    if (!type && item.role) {
      const role = item.role === 'assistant' || item.role === 'system' || item.role === 'tool'
        ? item.role
        : 'user';
      messages.push({ role, content: normalizeMessageContent(item.content) });
      continue;
    }

    if (type === 'message' || type === 'input_message') {
      const role = item.role === 'assistant' || item.role === 'system' || item.role === 'developer'
        ? (item.role === 'developer' ? 'system' : item.role)
        : 'user';
      messages.push({ role, content: normalizeMessageContent(item.content) });
      continue;
    }

    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || newId('call'),
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      });
      continue;
    }

    if (type === 'function_call' || type === 'custom_tool_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || newId('call'),
          type: 'function',
          function: {
            name: item.name || 'function',
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments ?? {})
          }
        }]
      });
      continue;
    }

    if (type === 'input_text') {
      messages.push({ role: 'user', content: String(item.text || '') });
      continue;
    }

    if (type === 'input_image') {
      const url = item.image_url?.url || item.image_url || item.url;
      if (url) {
        messages.push({
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: String(url) } }]
        });
      }
      continue;
    }

    // 未知 item：尽量抽文本，避免静默丢弃
    if (typeof item.content !== 'undefined') {
      messages.push({ role: 'user', content: normalizeMessageContent(item.content) });
    } else if (typeof item.text === 'string') {
      messages.push({ role: 'user', content: item.text });
    }
  }

  return messages;
}

/** Responses function tool → Chat Completions tools[] */
function mapResponsesTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return null;
    if (BUILTIN_TOOL_TYPES.has(String(t.type || ''))) {
      // 内建工具：Chat 管线不识别，原样塞进 body.tools 无意义；跳过以免污染
      return null;
    }
    if (t.type === 'function' && t.function?.name) {
      return t;
    }
    // Responses 扁平 function：{ type:'function', name, description, parameters }
    if (t.type === 'function' && t.name) {
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || t.input_schema || { type: 'object', properties: {} }
        }
      };
    }
    return null;
  }).filter(Boolean);
}

/**
 * Responses 请求体 → 内部 Chat Completions 请求体
 */
export function responsesRequestToOpenAIBody(body = {}) {
  if (body.previous_response_id) {
    // 网关无 store：无法续写服务端状态；依赖客户端把历史放进 input
  }

  const messages = responsesInputToMessages(body.input, { instructions: body.instructions });
  const out = {
    model: body.model,
    messages,
    stream: Boolean(body.stream),
    temperature: body.temperature,
    top_p: body.top_p ?? body.topP,
    max_tokens: body.max_output_tokens ?? body.max_tokens ?? body.maxTokens,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls ?? body.parallelToolCalls
  };

  const tools = mapResponsesTools(body.tools);
  if (tools?.length) out.tools = tools;

  // 扩展字段：工作流 / 工作区（XRK）
  if (body.workflow != null) out.workflow = body.workflow;
  if (body.workspace != null) out.workspace = body.workspace;

  // reasoning.effort → 透传给工厂常见 overrides 名（有则生效）
  const effort = body.reasoning?.effort ?? body.reasoning_effort;
  if (effort != null && effort !== '') out.reasoning_effort = effort;

  return out;
}

function buildUsage(completionUsage = {}) {
  const input = completionUsage.prompt_tokens ?? completionUsage.input_tokens ?? 0;
  const output = completionUsage.completion_tokens ?? completionUsage.output_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: completionUsage.prompt_tokens_details?.cached_tokens ?? 0
    },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: completionUsage.completion_tokens_details?.reasoning_tokens ?? 0
    },
    total_tokens: completionUsage.total_tokens ?? (input + output)
  };
}

function messageOutputItem({ msgId, text, toolCalls }) {
  if (Array.isArray(toolCalls) && toolCalls.length) {
    return toolCalls.map((tc) => ({
      id: tc.id || newId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: tc.id || newId('call'),
      name: tc.function?.name || tc.name || 'function',
      arguments: typeof tc.function?.arguments === 'string'
        ? tc.function.arguments
        : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {})
    }));
  }

  return [{
    id: msgId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{
      type: 'output_text',
      text: String(text || ''),
      annotations: []
    }]
  }];
}

/**
 * Chat Completions JSON → Responses 对象
 * @see API reference Response object
 */
export function openAIChatToResponsesObject(completion, {
  model,
  instructions = null,
  temperature = null,
  topP = null,
  maxOutputTokens = null,
  toolChoice = 'auto',
  tools = [],
  status = 'completed'
} = {}) {
  const choice = completion?.choices?.[0];
  const msg = choice?.message || {};
  const text = msg.content ?? '';
  const toolCalls = msg.tool_calls;
  const respId = (completion?.id || '').replace(/^chatcmpl_/, 'resp_') || newId('resp');
  const msgId = newId('msg');
  const created = completion?.created || Math.floor(Date.now() / 1000);
  const output = messageOutputItem({ msgId, text, toolCalls });

  return {
    id: respId.startsWith('resp_') ? respId : `resp_${respId}`,
    object: 'response',
    created_at: created,
    status,
    error: null,
    incomplete_details: status === 'incomplete'
      ? { reason: mapIncompleteReason(choice?.finish_reason) }
      : null,
    instructions,
    max_output_tokens: maxOutputTokens,
    model: model || completion?.model || 'unknown',
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature,
    text: { format: { type: 'text' } },
    tool_choice: toolChoice ?? 'auto',
    tools: Array.isArray(tools) ? tools : [],
    top_p: topP,
    truncation: 'disabled',
    usage: buildUsage(completion?.usage),
    user: null,
    metadata: {},
    // SDK 便利字段（官方 JSON 不一定带；兼容客户端）
    output_text: typeof text === 'string' ? text : ''
  };
}

function mapIncompleteReason(finishReason) {
  const r = String(finishReason || '').toLowerCase();
  if (r === 'length') return 'max_output_tokens';
  if (r === 'content_filter') return 'content_filter';
  return 'max_output_tokens';
}

export const initResponsesSSE = initGatewaySSE;

/**
 * 文本流 → Responses 语义化 SSE（最小完备生命周期）
 * 事件顺序对齐官方示例：
 * created → in_progress → output_item.added → content_part.added
 * → output_text.delta* → output_text.done → content_part.done
 * → output_item.done → completed
 */
export async function pipeResponsesStream(res, {
  client,
  messages,
  overrides,
  model,
  instructions = null,
  temperature = null,
  topP = null,
  maxOutputTokens = null,
  toolChoice = 'auto',
  tools = [],
  runWrapped = (run) => run()
}) {
  let seq = 0;
  const nextSeq = () => {
    seq += 1;
    return seq;
  };

  const respId = newId('resp');
  const msgId = newId('msg');
  const createdAt = Math.floor(Date.now() / 1000);

  const baseResponse = {
    id: respId,
    object: 'response',
    created_at: createdAt,
    status: 'in_progress',
    error: null,
    incomplete_details: null,
    instructions,
    max_output_tokens: maxOutputTokens,
    model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature,
    text: { format: { type: 'text' } },
    tool_choice: toolChoice ?? 'auto',
    tools: Array.isArray(tools) ? tools : [],
    top_p: topP,
    truncation: 'disabled',
    usage: null,
    user: null,
    metadata: {}
  };

  const emit = (type, extra = {}) => {
    writeNamedSSE(res, type, { type, sequence_number: nextSeq(), ...extra });
  };

  emit('response.created', { response: { ...baseResponse } });
  emit('response.in_progress', { response: { ...baseResponse } });

  const itemStub = {
    id: msgId,
    type: 'message',
    status: 'in_progress',
    role: 'assistant',
    content: []
  };
  emit('response.output_item.added', { output_index: 0, item: itemStub });
  emit('response.content_part.added', {
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] }
  });

  let total = '';
  try {
    await runWrapped(async () => {
      await client.chatStream(messages, (delta) => {
        if (typeof delta !== 'string' || !delta) return;
        total += delta;
        emit('response.output_text.delta', {
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          delta
        });
      }, overrides);
    });
  } catch (error) {
    emit('response.failed', {
      response: {
        ...baseResponse,
        status: 'failed',
        error: { code: 'server_error', message: error?.message || String(error) }
      }
    });
    emit('error', {
      code: 'server_error',
      message: error?.message || String(error),
      param: null
    });
    throw error;
  }

  emit('response.output_text.done', {
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    text: total
  });
  emit('response.content_part.done', {
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: total, annotations: [] }
  });

  const finalItem = {
    id: msgId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: total, annotations: [] }]
  };
  emit('response.output_item.done', { output_index: 0, item: finalItem });

  const approxIn = Math.max(1, Math.ceil(JSON.stringify(messages).length / 4));
  const approxOut = Math.max(1, Math.ceil(total.length / 4));
  const completed = {
    ...baseResponse,
    status: 'completed',
    output: [finalItem],
    usage: {
      input_tokens: approxIn,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: approxOut,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: approxIn + approxOut
    },
    output_text: total
  };
  emit('response.completed', { response: completed });
  return total;
}
