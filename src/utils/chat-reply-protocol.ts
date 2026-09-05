/**
 * chat.reply 正文协议（对齐 XRK-Yunzai lib/utils/chat-reply-protocol.js）
 * 文字、[at:QQ]、[回复:ID]；表情包走 emotion 工具，不在此解析。
 */

import { EMOTION_TYPES } from '#utils/emotion-categories.js';

export { EMOTION_TYPES } from '#utils/emotion-categories.js';

const AT_MARKER = /\[at:(\d{5,10})\]/gi;
/** 误写的 OneBot CQ at → 规范 [at:QQ] */
const CQ_AT_RE = /\[CQ:at,[^\]]*qq=(\d{5,10})[^\]]*\]/gi;

const EMOTION_TAG_RE = new RegExp(
  `\\[(${EMOTION_TYPES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\]`
);

type MsgSegmentApi = {
  at: (qq: unknown, name?: unknown) => unknown;
  reply: (id: unknown, text?: unknown, qq?: unknown, time?: unknown, seq?: unknown) => unknown;
  image: (file: unknown, name?: unknown) => unknown;
};

function getMsgSegment(): MsgSegmentApi {
  return (globalThis as { msgSegment?: MsgSegmentApi }).msgSegment!;
}

export type ReplyAtArgs = {
  at?: string | string[] | number;
  atSender?: boolean;
};

export type ReplyAtEvent = {
  user_id?: string | number;
  sender?: { user_id?: string | number };
} | null | undefined;

export type DisplaySegment = {
  type?: string;
  qq?: unknown;
  text?: unknown;
  data?: {
    qq?: unknown;
    uid?: unknown;
    text?: unknown;
  };
};

export type OutboundSegment = string | DisplaySegment | unknown;

/** Markdown 剥离时需保护的协议片段 */
export const PROTOCOL_MARKER_RE =
  /(\[at:\d{5,10}\]|(?:\[图片内容:[^\]]+\])|(?:\[回复:(?:ID:)?\d+\])|(?:\[CQ:[^\]]+\]))/gi;

/** 把 [CQ:at,qq=…] 收成 [at:QQ]，避免模型被教错协议后 @ 失效 */
export function normalizeReplyAtMarkers(text: unknown): string {
  return String(text ?? '').replace(CQ_AT_RE, '[at:$1]');
}

/**
 * 从 reply 工具参数收集要 @ 的 QQ（atSender / at）。
 */
export function collectReplyAtQqs(args: ReplyAtArgs = {}, e: ReplyAtEvent = null): string[] {
  const out: string[] = [];
  const push = (raw: unknown) => {
    const q = String(raw ?? '').trim();
    if (/^\d{5,10}$/.test(q) && !out.includes(q)) out.push(q);
  };
  if (args.atSender) {
    push(e?.user_id ?? e?.sender?.user_id);
  }
  const at = args.at;
  if (Array.isArray(at)) {
    for (const item of at) push(item);
  } else if (at != null && String(at).trim()) {
    for (const part of String(at).split(/[,，\s]+/)) push(part);
  }
  return out;
}

/**
 * 把 at QQ 列表前置成 [at:QQ]（已存在则不重复）。
 */
export function prependReplyAtMarkers(content: unknown, qqList: unknown[] = []): string {
  let work = normalizeReplyAtMarkers(content);
  const existing = new Set(
    [...work.matchAll(new RegExp(AT_MARKER.source, 'gi'))].map((m) => m[1]),
  );
  const prefix: string[] = [];
  for (const q of qqList) {
    const qq = String(q ?? '').trim();
    if (!/^\d{5,10}$/.test(qq) || existing.has(qq)) continue;
    prefix.push(`[at:${qq}]`);
    existing.add(qq);
  }
  if (!prefix.length) return work;
  return `${prefix.join('')}${work}`;
}

/** reply content 校验（先 normalizeReplyAtMarkers） */
export function replyContentForbidden(text: unknown): string | null {
  const s = normalizeReplyAtMarkers(text);
  if (EMOTION_TAG_RE.test(s)) return '发表情包请用 emotion 工具，勿在 reply 写 [开心] 等';
  if (/\[CQ:at/i.test(s)) return '禁止 [CQ:at]；群聊@用 [at:数字QQ]';
  const withoutAt = s.replace(AT_MARKER, '');
  if (/@/.test(withoutAt)) return '禁止 @QQ/@昵称；群聊@用 [at:数字QQ]';
  return null;
}

/** [at:QQ] → segment 数组，支持多处、多人 */
export function parseContentToSendSegments(text: unknown): OutboundSegment[] {
  const work = normalizeReplyAtMarkers(text);
  if (!work.trim()) return [];
  const out: OutboundSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(AT_MARKER.source, 'gi');
  const seg = getMsgSegment();
  while ((match = re.exec(work)) !== null) {
    if (match.index > last) {
      const chunk = work.slice(last, match.index);
      if (chunk) out.push(chunk);
    }
    out.push(seg.at(match[1]));
    last = match.index + match[0].length;
  }
  if (last < work.length) {
    const chunk = work.slice(last);
    if (chunk) out.push(chunk);
  }
  return out.length ? out : [work];
}

export function segmentsToDisplayText(segments: unknown, fallback = ''): string {
  if (!Array.isArray(segments) || !segments.length) return fallback;
  const parts = segments.map((s: unknown) => {
    if (typeof s === 'string') return s;
    const seg = s as DisplaySegment | null | undefined;
    if (seg?.type === 'at') return `@${seg.qq ?? seg.data?.qq ?? seg.data?.uid ?? ''}`;
    if (seg?.type === 'text') return seg.text ?? seg.data?.text ?? '';
    if (seg?.type === 'image') return '[图片]';
    return '';
  });
  const joined = parts.join('').trim();
  return joined || fallback;
}

/** 提取 [图片内容:]（仅记入历史，不发给用户） */
export function parseImageContentMark(text: unknown): {
  imageContent: string | null;
  text: string;
} {
  const imageContentRegex = /\[图片内容:([^\]]+)\]/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  const work = String(text ?? '');
  while ((match = imageContentRegex.exec(work)) !== null) {
    matches.push(match[1]);
  }
  if (!matches.length) return { imageContent: null, text: work };
  return {
    imageContent: matches.join('；'),
    text: work.replace(imageContentRegex, '').trim(),
  };
}

/** 提取 [回复:ID]，正文转 segment（含 [at:QQ]） */
export function parseReplyContentSegments(text: unknown): {
  replyId: string | null;
  segments: OutboundSegment[];
} {
  let replyId: string | null = null;
  let work = String(text ?? '');

  const replyShortMatch = work.match(/\[回复:(?:ID:)?(\d+)\]/);
  if (replyShortMatch) {
    replyId = replyShortMatch[1];
    work = work.replace(/\[回复:(?:ID:)?\d+\]/g, '').trim();
  }
  const replyMatch = work.match(/\[CQ:reply,id=(\d+)\]/i);
  if (replyMatch) {
    replyId = replyId || replyMatch[1];
    work = work.replace(/\[CQ:reply,id=\d+\]/gi, '').trim();
  }

  return { replyId, segments: parseContentToSendSegments(work) };
}

/**
 * 统一解析对外发送正文：图片内容标记、[回复:ID]、[at:QQ]。
 * fallbackReplyId 仅在调用方显式传入时作为引用兜底（如 messageId 参数）；默认不引用。
 */
export function resolveOutgoingMessage(
  text: unknown,
  { fallbackReplyId }: { fallbackReplyId?: unknown } = {},
): {
  imageContent: string | null;
  replyId: string | null;
  segments: OutboundSegment[];
  displayText: string;
} {
  const { imageContent, text: withoutImageMark } = parseImageContentMark(text);
  const { replyId, segments } = parseReplyContentSegments(withoutImageMark);
  const fallback = fallbackReplyId != null ? String(fallbackReplyId).trim() : '';
  const finalReplyId = replyId || fallback || null;
  const displayText = segmentsToDisplayText(segments, withoutImageMark);
  return { imageContent, replyId: finalReplyId, segments, displayText };
}

export function contentHasGroupAt(text: unknown): boolean {
  return /\[at:\d{5,10}\]/i.test(normalizeReplyAtMarkers(text));
}

/** 半角/全角 | 分句（reply / emotion 附言共用） */
export function splitProtocolParts(text: unknown): string[] {
  return String(text ?? '')
    .split(/[|｜]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 组装 e.reply 用的 segment 列表：可选回复头 + 图片 + 文字段。
 */
export function buildOutboundSegments({
  replyId,
  imagePaths = [],
  segments = [],
}: {
  replyId?: unknown;
  imagePaths?: unknown[];
  segments?: OutboundSegment[];
} = {}): OutboundSegment[] {
  const payload: OutboundSegment[] = [];
  const seg = getMsgSegment();
  if (replyId) payload.push(seg.reply(String(replyId)));
  for (const img of imagePaths) payload.push(seg.image(img));
  if (segments.length) payload.push(...segments);
  else if (replyId && !imagePaths.length) payload.push(' ');
  return payload;
}
