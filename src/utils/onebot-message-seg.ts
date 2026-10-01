/**
 * OneBot 消息段：事件/群历史多为扁平 { type, text|qq|id }；
 * get_msg 仍可能是 { type, data:{...} }。统一压平后再读字段。
 */

type SegLike = Record<string, unknown> & {
  data?: Record<string, unknown> | unknown;
  text?: unknown;
  qq?: unknown;
  user_id?: unknown;
  id?: unknown;
  name?: unknown;
  file_name?: unknown;
  file?: unknown;
  path?: unknown;
  url?: unknown;
  file_id?: unknown;
  fid?: unknown;
  message_id?: unknown;
};

/** 压平带 data 的消息段 */
export function flattenMessageSeg(seg: SegLike | null | undefined): SegLike | null | undefined {
  if (!seg || typeof seg !== 'object') return seg;
  const data = seg.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return seg;
  const { data: _d, ...rest } = seg;
  return { ...(data as Record<string, unknown>), ...rest };
}

/** 压平消息段数组 */
export function flattenMessageSegs(message: unknown): SegLike[] {
  if (!Array.isArray(message)) return [];
  return message.map((s) => flattenMessageSeg(s as SegLike)).filter(Boolean) as SegLike[];
}

export function segText(seg: SegLike | null | undefined): string {
  const s = flattenMessageSeg(seg);
  return s?.text != null ? String(s.text) : '';
}

export function segQq(seg: SegLike | null | undefined): string {
  const s = flattenMessageSeg(seg);
  const qq = s?.qq ?? s?.user_id;
  return qq != null && String(qq).trim() !== '' ? String(qq) : '';
}

export function segReplyId(seg: SegLike | null | undefined): string {
  const s = flattenMessageSeg(seg);
  const id = s?.id;
  return id != null && String(id).trim() !== '' ? String(id).trim() : '';
}

export function segFileName(seg: SegLike | null | undefined): string {
  const s = flattenMessageSeg(seg);
  return String(s?.name || s?.file_name || '未知');
}

/**
 * 统一取媒体引用（file / url / file_id）
 */
export function segMediaRef(seg: SegLike | null | undefined): {
  file: string;
  url: string;
  fileId: string;
  name: string;
} {
  const s = flattenMessageSeg(seg) || {};
  return {
    file: String(s.file ?? s.path ?? '').trim(),
    url: String(s.url ?? '').trim(),
    fileId: String(s.file_id ?? s.fid ?? s.id ?? '').trim(),
    name: String(s.name || s.file_name || '').trim(),
  };
}

/**
 * 收集 forward 段所有可用的 message_id（兼容 OneBot / NapCat）
 */
export function collectForwardIds(
  seg: unknown,
  contextMessageId: string | number | null | undefined,
): string[] {
  const ids: string[] = [];
  if (contextMessageId != null && contextMessageId !== '') ids.push(String(contextMessageId));
  if (seg == null) return [...new Set(ids)];
  if (typeof seg !== 'object') {
    ids.push(String(seg));
    return [...new Set(ids)];
  }
  const s = seg as SegLike;
  for (const k of ['message_id', 'id'] as const) {
    if (s[k] != null && s[k] !== '') ids.push(String(s[k]));
  }
  if (s.data && typeof s.data === 'object' && !Array.isArray(s.data)) {
    const data = s.data as Record<string, unknown>;
    for (const k of ['message_id', 'id'] as const) {
      if (data[k] != null && data[k] !== '') ids.push(String(data[k]));
    }
  }
  return [...new Set(ids)];
}
