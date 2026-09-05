/** OpenAI-like 上游常见限制：function.name 仅允许 [a-zA-Z0-9_-]，最长 64 */
const API_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

type ToolFunction = {
  name?: string;
  [key: string]: unknown;
};

type ToolDef = {
  type?: string;
  function?: ToolFunction;
  [key: string]: unknown;
};

type ToolCall = {
  function?: ToolFunction;
  [key: string]: unknown;
};

type ChatMessage = {
  role?: string;
  name?: string;
  tool_calls?: ToolCall[];
  [key: string]: unknown;
};

/**
 * 创建工具名规范化映射器（出站 API 用规范化名，执行 MCP 前还原）
 */
export function createToolNameMapper() {
  const map = new Map<string, string>();

  function normalize(originalName: unknown): unknown {
    if (!originalName || typeof originalName !== 'string') return originalName;
    if (API_TOOL_NAME_RE.test(originalName) && !/^\d/.test(originalName)) {
      return originalName;
    }

    let normalized = originalName
      .replace(/\./g, '_')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .substring(0, 64);
    if (/^\d/.test(normalized)) normalized = `tool_${normalized}`;
    if (!normalized) normalized = 'tool';

    map.set(normalized, originalName);
    return normalized;
  }

  function denormalize(normalizedName: string): string {
    return map.get(normalizedName) || normalizedName;
  }

  function normalizeTools(tools: unknown): unknown {
    if (!Array.isArray(tools)) return tools;
    return tools.map((tool: ToolDef) => {
      if (tool?.type === 'function' && tool.function?.name) {
        return {
          ...tool,
          function: { ...tool.function, name: normalize(tool.function.name) as string },
        };
      }
      return tool;
    });
  }

  function normalizeMessages(messages: unknown): unknown {
    if (!Array.isArray(messages)) return messages;
    return messages.map((msg: ChatMessage) => {
      if (!msg || typeof msg !== 'object') return msg;

      let next: ChatMessage = msg;
      if (msg.role === 'tool' && msg.name) {
        next = { ...next, name: normalize(msg.name) as string };
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        next = {
          ...next,
          tool_calls: msg.tool_calls.map((tc) => ({
            ...tc,
            function: tc.function?.name
              ? { ...tc.function, name: normalize(tc.function.name) as string }
              : tc.function,
          })),
        };
      }
      return next;
    });
  }

  function denormalizeToolCalls(toolCalls: unknown): unknown {
    if (!Array.isArray(toolCalls)) return toolCalls;
    return toolCalls.map((tc: ToolCall) => {
      if (tc.function?.name) {
        return {
          ...tc,
          function: { ...tc.function, name: denormalize(tc.function.name) },
        };
      }
      return tc;
    });
  }

  return {
    normalize,
    denormalize,
    normalizeTools,
    normalizeMessages,
    denormalizeToolCalls,
  };
}
