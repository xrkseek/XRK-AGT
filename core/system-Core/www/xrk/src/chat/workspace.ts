/**
 * 工作区工具（对齐原 ai-workspace-ui.js 核心逻辑）
 */

export { normalizeWorkspaceId } from '@/chat/llm-settings';

/** 目录面包屑 */
export interface Crumb {
  label: string;
  dir: string;
}

const TOOL_LABELS = {
  read: '读取',
  write: '写入',
  grep: '搜索',
  list_files: '列目录',
  run: '命令',
  web_fetch: '抓取',
  web_search: '搜索',
  delete_file: '删除',
  modify_file: '修改',
};

export function toolLabel(name: unknown): string {
  const short = String(name || '').split('.').pop() ?? '';
  return TOOL_LABELS[short as keyof typeof TOOL_LABELS] || short || '?';
}

export function formatBytes(n: unknown): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

export function breadcrumbParts(dir: unknown): Crumb[] {
  const parts = String(dir || '').split('/').filter(Boolean);
  const out: Crumb[] = [{ label: '根目录', dir: '' }];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push({ label: part, dir: acc });
  }
  return out;
}
