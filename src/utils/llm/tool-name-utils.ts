// @ts-nocheck
/** OpenAI-like 上游常见限制：function.name 仅允许 [a-zA-Z0-9_-]，最长 64 */
const API_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 创建工具名规范化映射器（出站 API 用规范化名，执行 MCP 前还原）
 * @returns {{
 *   normalize: (name: string) => string,
 *   denormalize: (name: string) => string,
 *   normalizeTools: (tools: unknown) => unknown,
 *   normalizeMessages: (messages: unknown) => unknown,
 *   denormalizeToolCalls: (toolCalls: unknown) => unknown
 * }}
 */
export function createToolNameMapper() {
  const map = new Map();

  function normalize(originalName) {
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

  function denormalize(normalizedName) {
    return map.get(normalizedName) || normalizedName;
  }

  function normalizeTools(tools) {
    if (!Array.isArray(tools)) return tools;
    return tools.map((tool) => {
      if (tool?.type === 'function' && tool.function?.name) {
        return {
          ...tool,
          function: { ...tool.function, name: normalize(tool.function.name) }
        };
      }
      return tool;
    });
  }

  function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map((msg) => {
      if (!msg || typeof msg !== 'object') return msg;

      let next = msg;
      if (msg.role === 'tool' && msg.name) {
        next = { ...next, name: normalize(msg.name) };
      }
      if (msg.tool_calls?.length > 0) {
        next = {
          ...next,
          tool_calls: msg.tool_calls.map((tc) => ({
            ...tc,
            function: tc.function?.name
              ? { ...tc.function, name: normalize(tc.function.name) }
              : tc.function
          }))
        };
      }
      return next;
    });
  }

  function denormalizeToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls)) return toolCalls;
    return toolCalls.map((tc) => {
      if (tc.function?.name) {
        return {
          ...tc,
          function: { ...tc.function, name: denormalize(tc.function.name) }
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
    denormalizeToolCalls
  };
}
