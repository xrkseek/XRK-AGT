const MCP_TOOL_TEXT_MAX_JSON = 8000;

function capToolText(text: unknown, maxLen: number = MCP_TOOL_TEXT_MAX_JSON): string {
  const s = String(text ?? '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}\n…(工具输出已截断 ${s.length} 字符，请概括要点后结束 tool 轮)`;
}

type ToolData = {
  content?: unknown;
  filePath?: unknown;
  path?: unknown;
  fileName?: unknown;
  truncated?: unknown;
  matches?: unknown[];
  pattern?: unknown;
  count?: unknown;
  items?: unknown[];
  files?: Array<{ path?: unknown; symbols?: unknown[] }>;
  output?: unknown;
  command?: unknown;
  stderr?: unknown;
  todos?: Array<{ status?: unknown; id?: unknown; content?: unknown }>;
  open?: unknown;
  done?: unknown;
};

/**
 * opencode toModelOutput 思路：按业务形状投影为模型友好短文，避免整包 JSON。
 */
function summarizeDataForModel(data: unknown, maxLen: number): string {
  if (data == null) return '';
  if (typeof data === 'string') return capToolText(data, maxLen);
  if (typeof data !== 'object') return '';
  const d = data as ToolData;

  // read
  if (typeof d.content === 'string' && (d.filePath || d.path || d.fileName)) {
    const pathHint = d.filePath || d.path || d.fileName;
    const trunc = d.truncated ? '（已截断）' : '';
    return capToolText(`文件 ${pathHint}${trunc}\n${d.content}`, maxLen);
  }
  // grep
  if (Array.isArray(d.matches)) {
    const lines = d.matches.slice(0, 40).map((m) => {
      if (typeof m === 'string') return m;
      const row = m as { file?: unknown; path?: unknown; line?: unknown; content?: unknown; text?: unknown };
      const loc = [row.file, row.path, row.line].filter((x) => x != null).join(':');
      return `${loc}${loc ? ' ' : ''}${row.content ?? row.text ?? JSON.stringify(m)}`;
    });
    const more = d.matches.length > 40 ? `\n…共 ${d.count ?? d.matches.length} 条` : '';
    return capToolText(`grep「${d.pattern || ''}」${d.count != null ? ` ${d.count} 命中` : ''}\n${lines.join('\n')}${more}`, maxLen);
  }
  // list_files / repo_map
  if (Array.isArray(d.items)) {
    const lines = d.items.slice(0, 80).map((it) => {
      if (typeof it === 'string') return it;
      const row = it as { type?: unknown; name?: unknown; path?: unknown };
      return `${row.type === 'directory' ? 'dir' : 'file'} ${row.name || row.path || ''}`;
    });
    return capToolText(`目录 ${d.path || ''}（${d.count ?? d.items.length}）\n${lines.join('\n')}`, maxLen);
  }
  if (Array.isArray(d.files) && d.files[0]?.path) {
    const lines = d.files.slice(0, 60).map((f) => {
      const sym = Array.isArray(f.symbols) && f.symbols.length ? ` {${f.symbols.slice(0, 6).join(', ')}}` : '';
      return `- ${f.path}${sym}`;
    });
    return capToolText(`repo_map ${d.count ?? d.files.length} 文件\n${lines.join('\n')}`, maxLen);
  }
  // run
  if (typeof d.output === 'string' && d.command != null) {
    const err = d.stderr ? `\nstderr: ${d.stderr}` : '';
    const trunc = d.truncated ? '（输出已截断）' : '';
    return capToolText(`$ ${d.command}${trunc}\n${d.output}${err}`, maxLen);
  }
  // todos
  if (Array.isArray(d.todos)) {
    const lines = d.todos.map((t) => `- [${t.status || '?'}] ${t.id}: ${t.content}`);
    return capToolText(`todos open=${d.open ?? '?'} done=${d.done ?? '?'}\n${lines.join('\n')}`, maxLen);
  }

  try {
    const str = JSON.stringify(d);
    if (str && str !== '{}') return capToolText(str, maxLen);
  } catch {
    /* ignore */
  }
  return '';
}

type ToolResult = {
  success?: boolean;
  error?: unknown;
  raw?: unknown;
  message?: unknown;
  data?: ToolData;
};

/** 将工具返回值整理为 AI 可读文本（优先 raw / message，避免整段 JSON 误导模型重复调用） */
export function summarizeToolResultText(result: unknown, maxLen: number = MCP_TOOL_TEXT_MAX_JSON): string {
  if (result == null) return '已执行';
  if (typeof result !== 'object') return capToolText(String(result), maxLen);
  const r = result as ToolResult;
  if (r.success === false) {
    const err = r.error;
    const out = typeof err === 'string' ? err : ((err as { message?: string } | null)?.message || JSON.stringify(err));
    return capToolText(out, maxLen);
  }
  if (typeof r.raw === 'string' && r.raw.trim()) {
    return capToolText(r.raw.trim(), maxLen);
  }
  const msg = r.message;
  if (msg != null && msg !== '') {
    return capToolText(String(msg), maxLen);
  }
  const data = r.data;
  if (data != null) {
    const projected = summarizeDataForModel(data, maxLen);
    if (projected) return projected;
  }
  try {
    const str = JSON.stringify(result);
    if (str && str !== '{}') return capToolText(str, maxLen);
  } catch {
    /* ignore */
  }
  return '已执行';
}

const HISTORY_ARG_KEYS = ['command', 'query', 'path', 'url', 'messageId', 'limit', 'content', 'saveAs'] as const;

/**
 * 写入下一轮群聊 prompt 的工具摘要（短；对外 reply 类工具应跳过记录）。
 * 语义对齐 XRK-Yunzai：只进历史，不出现在用户可见气泡。
 */
export function summarizeToolForHistory(
  toolName: unknown,
  result: unknown,
  args: Record<string, unknown> | null = null,
  maxLen: number = 600,
): string {
  const full = String(toolName || 'tool');
  const shortName = full.includes('.') ? full.split('.').slice(-2).join('.') : full;
  let argHint = '';
  if (args && typeof args === 'object') {
    for (const key of HISTORY_ARG_KEYS) {
      if (args[key] == null || args[key] === '') continue;
      const s = String(args[key]).replace(/\s+/g, ' ').trim();
      if (!s) continue;
      argHint = s.length > 100 ? `${s.slice(0, 100)}…` : s;
      break;
    }
  }
  const head = argHint ? `${shortName}「${argHint}」` : shortName;
  if (result && typeof result === 'object' && (result as ToolResult).success === false) {
    const errVal = (result as ToolResult).error;
    const err = typeof errVal === 'string'
      ? errVal
      : ((errVal as { message?: string } | null)?.message || summarizeToolResultText(result, 200));
    return capToolText(`${head} → 失败: ${String(err).slice(0, 220)}`, maxLen);
  }
  const body = summarizeToolResultText(result, Math.max(80, maxLen - head.length - 4));
  return `${head} → ${body}`.slice(0, maxLen + 80);
}
