/**
 * 聊天 segments 规范化与媒体 URL（对齐原 appendSegments）
 *
 * 形态权威：Runtime 侧 `msgSegment`（`src/infrastructure/.../msg-segment`）。
 * 归一化输出结构见 `@/types` 的 `NormalizedSegment`。
 */
import { getServerUrl } from '@/api/client';
import type { LoosePayload, NormalizedSegment } from '@/types';

export function resolveMediaUrl(url: unknown): string {
  if (!url || typeof url !== 'string') return '';
  const u = url.trim();
  if (!u) return '';
  if (/^(https?:|data:|blob:|\/\/)/i.test(u)) return u;
  const base = getServerUrl().replace(/\/$/, '');
  return u.startsWith('/') ? `${base}${u}` : `${base}/${u}`;
}

/** 从任意 WS/HTTP 载荷提取 segments */
export function extractSegments(data: LoosePayload): NormalizedSegment[] {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.segments) && data.segments.length) {
    return data.segments.map(normalizeSeg).filter(Boolean) as NormalizedSegment[];
  }
  if (Array.isArray(data.message) && data.message.length) {
    return data.message.map(normalizeSeg).filter(Boolean) as NormalizedSegment[];
  }
  if (data.type === 'image' && data.url) return [{ type: 'image', url: data.url }];
  if (typeof data.content === 'string' && data.content.trim()) {
    return [{ type: 'text', text: data.content }];
  }
  if (typeof data.text === 'string' && data.text.trim()) {
    return [{ type: 'text', text: data.text }];
  }
  if (typeof data.message === 'string' && data.message.trim()) {
    return [{ type: 'text', text: data.message }];
  }
  return [];
}

function mediaUrlFrom(seg: LoosePayload): string {
  return seg.url || seg.file || seg.data?.url || seg.data?.file || seg.data?.path || '';
}

export function normalizeSeg(seg: unknown): NormalizedSegment | null {
  if (seg == null) return null;
  if (typeof seg === 'string') {
    const t = seg.trim();
    return t ? { type: 'text', text: seg } : null;
  }
  if (typeof seg !== 'object') return null;
  const s = seg as LoosePayload;
  const type = String(s.type || 'text').toLowerCase();
  if (type === 'text' || type === 'markdown' || type === 'raw') {
    const text = s.text ?? s.content ?? s.data?.text ?? '';
    if (!String(text).length) return null;
    const out = type === 'markdown' ? 'markdown' : type === 'raw' ? 'raw' : 'text';
    return { type: out, text: String(text) } as NormalizedSegment;
  }
  if (type === 'tools') {
    const tools = Array.isArray(s.tools) ? s.tools : [];
    return tools.length ? { type: 'tools', tools } : null;
  }
  if (type === 'image' || type === 'mface') {
    const url = mediaUrlFrom(s);
    return url ? { type: 'image', url: String(url), name: s.name || s.summary || '' } : null;
  }
  if (type === 'video') {
    const url = mediaUrlFrom(s);
    return url ? { type: 'video', url: String(url), name: s.name || '' } : null;
  }
  if (type === 'record' || type === 'audio') {
    const url = mediaUrlFrom(s);
    return url ? { type: 'record', url: String(url), name: s.name || '' } : null;
  }
  if (type === 'file') {
    const url = mediaUrlFrom(s);
    return url
      ? { type: 'file', url: String(url), name: s.name || s.file_name || '文件' }
      : { type: 'file', url: '', name: s.name || s.file_name || '文件' };
  }
  if (type === 'at') {
    return {
      type: 'at',
      qq: String(s.qq ?? s.user_id ?? ''),
      name: String(s.name ?? ''),
    };
  }
  if (type === 'reply') {
    return {
      type: 'reply',
      id: s.id ?? s.message_id ?? '',
      text: String(s.text || s.content || ''),
    };
  }
  if (type === 'forward' || type === 'node') {
    const id = s.id ?? s.message_id ?? s.data?.id ?? '';
    const inner = s.content || s.message || s.data?.content || s.data?.message;
    const lines: NormalizedSegment[] = Array.isArray(inner)
      ? (inner.map((c) => normalizeSeg(c)).filter(Boolean) as NormalizedSegment[])
      : [];
    return {
      type: 'forward',
      id: id != null ? String(id) : '',
      segments: lines,
      text: lines.length ? segmentsToPlainText(lines) : '[转发]',
    };
  }
  if (type === 'face') {
    return { type: 'text', text: '[表情]' };
  }
  if (type === 'poke') {
    const qq = s.qq ?? s.user_id ?? '';
    return { type: 'poke', qq: String(qq), text: qq ? `戳了戳 ${qq}` : '戳一戳' };
  }
  const fallback = s.text || s.content;
  return fallback ? { type: 'text', text: String(fallback) } : null;
}

export function segmentsToPlainText(segments: unknown): string {
  if (!Array.isArray(segments)) return '';
  return segments
    .map((seg) => {
      const s = seg as NormalizedSegment | null;
      if (!s) return '';
      if (s.type === 'text' || s.type === 'markdown' || s.type === 'raw') return s.text || '';
      if (s.type === 'reply') return s.text ? `「引用」${s.text}` : '';
      if (s.type === 'at') return s.name ? `@${s.name}` : s.qq ? `@${s.qq}` : '@';
      if (s.type === 'image') return '[图片]';
      if (s.type === 'video') return '[视频]';
      if (s.type === 'record') return '[语音]';
      if (s.type === 'file') return `[文件] ${s.name || ''}`.trim();
      if (s.type === 'forward') return s.text || '[转发]';
      if (s.type === 'poke') return s.text || '[戳一戳]';
      if (s.type === 'tools') return '[工具调用]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function isAckOnlyText(text: unknown): boolean {
  const t = String(text || '').trim().toLowerCase();
  return !t || t === 'event triggered' || t === 'ok' || t === 'success' || t === 'true';
}

function snippetFromContentParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const bits: string[] = [];
  for (const c of parts as LoosePayload[]) {
    if (!c) continue;
    const t = String(c.type || '').toLowerCase();
    if (t === 'text') bits.push(c.data?.text || c.text || '');
    else if (t === 'image' || t === 'mface') bits.push('[图片]');
    else if (t === 'video') bits.push('[视频]');
    else if (t === 'record' || t === 'audio') bits.push('[语音]');
    else if (t === 'file') bits.push(`[文件] ${c.name || c.data?.name || ''}`.trim());
    else if (t === 'forward' || t === 'node') bits.push('[转发]');
  }
  return bits.filter(Boolean).join(' ');
}

/** 从 forward/reply 载荷提取记录卡消息行（含媒体摘要） */
export function extractForwardLines(data: LoosePayload | null | undefined): string[] {
  const messages = data?.messages;
  if (!Array.isArray(messages) || !messages.length) return [];
  return (messages as any[])
    .map((msg) => {
      if (typeof msg === 'string') return msg;
      if (msg?.type === 'node' && Array.isArray(msg.data?.content)) {
        return snippetFromContentParts(msg.data.content);
      }
      if (Array.isArray(msg?.message)) {
        return snippetFromContentParts(msg.message);
      }
      if (Array.isArray(msg?.content)) {
        return snippetFromContentParts(msg.content);
      }
      return msg?.text || msg?.content || '';
    })
    .filter((t) => String(t || '').trim());
}