/**
 * MCP 工具块辅助（对齐原 _parseToolResultPayload / _buildToolResultPreview / _summarizeToolResultText）
 */
import { deepClone } from '@/utils/http';
import type { LoosePayload } from '@/types';

/** MCP 工具条目（OpenAI function-calling 形状） */
export interface ToolLike extends LoosePayload {
  name?: string;
  arguments?: unknown;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

/** 工具结果预览（图片等） */
export interface ToolPreview {
  type: 'image';
  src: string;
  alt: string;
}

export function parseToolResultPayload(result: unknown): any | null {
  if (result == null || result === '') return null;
  if (typeof result === 'object') return result;
  if (typeof result !== 'string') return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

export function toolArgsText(tool: ToolLike | null | undefined): string {
  const args = tool?.arguments ?? tool?.function?.arguments ?? {};
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function toolName(tool: ToolLike | null | undefined): string {
  return tool?.name || tool?.function?.name || '工具';
}

export function toolResultPreview(
  name: string,
  payload: LoosePayload | null | undefined,
): ToolPreview | null {
  const data = (payload?.data ?? payload) as LoosePayload | undefined;
  const mime = data?.mimeType || data?.mime;
  const b64 = data?.base64;
  if (typeof b64 === 'string' && b64.length > 40 && String(mime || '').startsWith('image/')) {
    return {
      type: 'image',
      src: `data:${mime || 'image/png'};base64,${b64}`,
      alt: `${name} 截图`,
    };
  }
  return null;
}

export function summarizeToolResultText(payload: unknown): string {
  if (payload == null || payload === '') return '';
  const clone = typeof payload === 'object' ? deepClone(payload) : parseToolResultPayload(payload);
  if (clone && typeof clone === 'object') {
    const data = (clone.data ?? clone) as LoosePayload;
    if (data?.base64 && String(data.base64).length > 200) {
      data.base64 = `[base64 ${String(data.base64).length} chars]`;
    }
    try {
      const s = JSON.stringify(clone, null, 2);
      return s.length > 8000 ? `${s.slice(0, 8000)}\n…` : s;
    } catch {
      return String(payload);
    }
  }
  const s = String(payload);
  return s.length > 8000 ? `${s.slice(0, 8000)}\n…` : s;
}

/** 工具是否可能改动工作区文件（用于刷目录） */
export function toolsMayTouchWorkspace(tools: unknown): boolean {
  if (!Array.isArray(tools) || !tools.length) return false;
  const touch = /^(write|delete_file|modify_file|run|bash|shell)/i;
  return tools.some((t: ToolLike) => {
    const name = String(toolName(t)).split('.').pop() || '';
    return touch.test(name);
  });
}
