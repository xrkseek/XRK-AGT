// @ts-nocheck
/**
 * 解析 LLM / MCP 工具 arguments。
 * 唯一解析入口：MCPServer.handleToolCall；历史转换等可复用本模块。
 * 覆盖：双层 JSON 字符串、```json 围栏、仅 `{ raw }` 包装。
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 若对象只有 `raw` 字符串字段，返回该字符串；否则返回 null。
 * @param {Record<string, unknown>} obj
 * @returns {string|null}
 */
function onlyRawString(obj) {
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'raw' && typeof obj.raw === 'string') {
    return obj.raw;
  }
  return null;
}

/**
 * @param {string} s
 */
function snippetOf(s) {
  const t = String(s || '');
  if (t.length <= 400) return t;
  return `${t.slice(0, 200)}…[${t.length} chars]…${t.slice(-120)}`;
}

/**
 * @param {unknown} rawInput
 * @returns {{ ok: true, args: Record<string, unknown> } | { ok: false, args: Record<string, unknown>, error: string, snippet: string }}
 */
export function parseToolCallArguments(rawInput) {
  if (rawInput == null || rawInput === '') {
    return { ok: true, args: {} };
  }

  let cur = rawInput;
  if (isPlainObject(cur)) {
    const raw = onlyRawString(cur);
    if (raw == null) return { ok: true, args: cur };
    cur = raw;
  }

  if (typeof cur !== 'string') {
    return {
      ok: false,
      args: {},
      error: `arguments 类型无效: ${typeof cur}`,
      snippet: ''
    };
  }

  let s = cur.trim();
  if (!s) return { ok: true, args: {} };

  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json|JSON)?\s*\r?\n?/, '').replace(/\r?\n?```\s*$/, '').trim();
  }

  let lastErr = '';
  for (let depth = 0; depth < 3; depth++) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') {
        s = parsed.trim();
        continue;
      }
      if (isPlainObject(parsed)) {
        const raw = onlyRawString(parsed);
        if (raw != null) {
          s = raw.trim();
          continue;
        }
        return { ok: true, args: parsed };
      }
      return {
        ok: false,
        args: { raw: s },
        error: `arguments 解析结果不是对象: ${typeof parsed}`,
        snippet: snippetOf(s)
      };
    } catch (err) {
      lastErr = err?.message != null ? String(err.message) : String(err);
      break;
    }
  }

  return {
    ok: false,
    args: { raw: s },
    error: `arguments JSON 解析失败: ${lastErr}`,
    snippet: snippetOf(s)
  };
}

/**
 * 日志用短预览（轻量，不做完整 JSON 业务解析；解析只在 MCPServer）。
 * @param {unknown} rawInput
 * @returns {string}
 */
export function previewToolCallArguments(rawInput) {
  if (rawInput == null || rawInput === '') return '{}';
  if (typeof rawInput === 'string') {
    const t = rawInput.trim();
    return t.length > 240 ? `${t.slice(0, 160)}…(${t.length} chars)` : t;
  }
  if (!isPlainObject(rawInput)) return String(rawInput);
  try {
    const keys = Object.keys(rawInput);
    const focus = {};
    for (const k of keys.slice(0, 12)) {
      const v = rawInput[k];
      focus[k] = typeof v === 'string' && v.length > 120 ? `${v.slice(0, 80)}…(${v.length} chars)` : v;
    }
    const s = JSON.stringify(focus);
    return keys.length > 12 ? `${s} (+${keys.length - 12} keys)` : s;
  } catch {
    return '[unserializable arguments]';
  }
}

/** 解析失败时回给模型的统一文案 */
export function toolArgumentsParseHint(error) {
  return `${error}。请输出合法 JSON 对象参数（勿包一层字符串）；大文件可先短 write 再 search_replace 追加。`;
}
