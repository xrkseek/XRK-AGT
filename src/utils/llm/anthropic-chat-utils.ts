import { parseToolCallArguments } from '#utils/llm/parse-tool-arguments.js';

type ToolCall = {
  id?: string;
  function?: { name?: string; arguments?: unknown };
};

type OpenAIMessage = Record<string, unknown> & {
  role?: string;
  content?: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type AnthropicContentBlock = Record<string, unknown> & {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
};

type AnthropicMessage = Record<string, unknown> & {
  role?: string;
  content?: string | AnthropicContentBlock[];
};

type ToolNameMapper = {
  normalize: (name: unknown) => unknown;
};

type AnthropicToolChoice =
  | { type: 'none' }
  | { type: 'any' }
  | { type: 'auto' }
  | { type: 'tool'; name: string };

type AnthropicToolDef = Record<string, unknown> & { name?: string };

type LlmConfigLike = Record<string, unknown>;

/** OpenAI 风格 messages → Anthropic Messages（含 tool / tool_calls 历史） */
export function normalizeAnthropicMessages(messages: OpenAIMessage[] = []): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const m of messages ?? []) {
    const role = (m?.role ?? '').toLowerCase();

    if (role === 'tool') {
      const last = out[out.length - 1];
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      };
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const blocks: AnthropicContentBlock[] = [];
      const text = typeof m.content === 'string' ? m.content.trim() : '';
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || 'tool',
          input: parseToolCallArguments(tc.function?.arguments).args,
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    out.push(m as AnthropicMessage);
  }

  return out;
}

function mapToolChoice(value: unknown, toolNameMapper: ToolNameMapper | null = null): AnthropicToolChoice {
  const raw = (value ?? 'auto').toString().trim();
  const v = raw.toLowerCase();
  if (v === 'none') return { type: 'none' };
  if (v === 'required' || v === 'any') return { type: 'any' };
  if (v === 'auto') return { type: 'auto' };
  const name = String(toolNameMapper?.normalize(raw) ?? raw);
  return { type: 'tool', name };
}

/** 多轮 tool_use 历史：出站前将 MCP 名（如 chat.poke）规范为 API 合法名（chat_poke） */
export function normalizeAnthropicToolHistory(
  messages: AnthropicMessage[] = [],
  toolNameMapper: ToolNameMapper | null = null,
): AnthropicMessage[] {
  if (!toolNameMapper || !Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((block: AnthropicContentBlock) => {
      if (block?.type === 'tool_use' && block.name) {
        const normalized = toolNameMapper.normalize(block.name);
        if (normalized !== block.name) {
          changed = true;
          return { ...block, name: String(normalized) };
        }
      }
      return block;
    });
    return changed ? { ...m, content } : m;
  });
}

export function applyAnthropicTools(
  body: Record<string, unknown>,
  config: LlmConfigLike = {},
  overrides: LlmConfigLike = {},
  toolNameMapper: ToolNameMapper | null = null,
): Record<string, unknown> {
  const customTools = Array.isArray(overrides.tools)
    ? (overrides.tools as AnthropicToolDef[]).filter(Boolean)
    : [];
  if (!customTools.length) return body;

  body.tools = toolNameMapper
    ? customTools.map((t) => ({ ...t, name: String(toolNameMapper.normalize(t.name)) }))
    : customTools;
  const choice = overrides.tool_choice ?? overrides.toolChoice ?? config.toolChoice;
  if (choice != null) body.tool_choice = mapToolChoice(choice, toolNameMapper);
  return body;
}

export function ensureAnthropicMaxTokens(
  body: Record<string, unknown>,
  config: LlmConfigLike = {},
  overrides: LlmConfigLike = {},
): number {
  if (body.max_tokens != null) return Number(body.max_tokens);
  const maxTokens =
    overrides.maxTokens ?? overrides.max_tokens ?? config.maxTokens ?? config.max_tokens ?? 4096;
  body.max_tokens = maxTokens;
  return Number(maxTokens);
}
