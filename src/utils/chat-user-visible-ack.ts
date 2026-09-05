/** chat reply / 表情标记等对用户可见内容的 MCP 回执文案 */

export type UserVisibleTurnState = {
  queuedReplyContent: string;
  queuedReplyMessageId: string | number | null;
  lastOutboundSummary: string;
  /** reply 已在工具轮内发出，execute 勿再发 */
  replyFlushed: boolean;
};

export function createUserVisibleTurnState(): UserVisibleTurnState {
  return {
    queuedReplyContent: '',
    queuedReplyMessageId: null,
    lastOutboundSummary: '',
    replyFlushed: false,
  };
}

export const TOOL_DELIVERED_FOOTER = '已送达。';

export function formatSessionWhere(e: { group_id?: unknown; user_id?: unknown } | null | undefined): string {
  if (e?.group_id) return `群 ${e.group_id}`;
  if (e?.user_id) return `用户 ${e.user_id}(私聊)`;
  return '当前会话';
}

export function formatUserVisibleSentAck(where: string, summary: unknown): string {
  const line = String(summary ?? '').trim();
  if (!line) {
    return `你未向${where}发出新的可见内容。\n${TOOL_DELIVERED_FOOTER}`;
  }
  return `你已在${where}发出：${line}。用户在 QQ 里已能看到。\n${TOOL_DELIVERED_FOOTER}`;
}

export function formatUserVisibleDuplicateAck(
  where: string,
  alreadySent: unknown,
  attemptedTool: unknown,
): string {
  const prev = String(alreadySent ?? '').trim();
  const tool = String(attemptedTool ?? 'reply').trim();
  return `你已在本次对话中向${where}发出过：${prev || '可见内容'}，用户已看到。本次 ${tool} 未再发送。\n${TOOL_DELIVERED_FOOTER}`;
}

/** AGT：reply 已立即发到 QQ（工具轮内 flush） */
export function formatReplySentAck(where: string, content: unknown, messageId: unknown): string {
  const line = String(content ?? '').trim();
  const ref = messageId != null && String(messageId).trim()
    ? `（引用消息 ${String(messageId).trim()}）`
    : '';
  return `你已通过 reply 向${where}发出${ref}：「${line}」。用户在 QQ 里已能看到。若无其它工具任务，结束 tool 调用即可。\n${TOOL_DELIVERED_FOOTER}`;
}

/** @deprecated 保留兼容：旧「仅拟定、稍后统一发」文案；现 reply 已立即发送 */
export function formatReplyQueuedAck(where: string, content: unknown, messageId: unknown): string {
  return formatReplySentAck(where, content, messageId);
}

export function formatDeliveredAck(where: string, sentLines: unknown): string {
  const items = (Array.isArray(sentLines) ? sentLines : [sentLines])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
  if (!items.length) {
    return `你未向${where}发出可见文字。\n${TOOL_DELIVERED_FOOTER}`;
  }
  const body = items.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `你已在${where}发出 ${items.length} 条文字：\n${body}\n用户在 QQ 里已能看到。若无其它待办，本轮结束。\n${TOOL_DELIVERED_FOOTER}`;
}

export function actionAck(detail: unknown): string {
  const line = String(detail ?? '').trim();
  if (!line) return TOOL_DELIVERED_FOOTER;
  return `${line}\n${TOOL_DELIVERED_FOOTER}`;
}

function normalizeVisibleCompare(text: unknown): string {
  return String(text ?? '')
    .replace(/\[回复:(?:ID:)?\d+\]/gi, '')
    .replace(/\[CQ:reply,id=\d+\]/gi, '')
    .replace(/\[at:\d{5,10}\]/gi, '')
    .replace(/\[(开心|惊讶|伤心|大笑|害怕|生气)\]/g, '')
    .replace(/[，。！？~、|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isOverlappingUserVisible(nextText: unknown, prevText: unknown): boolean {
  const a = normalizeVisibleCompare(nextText);
  const b = normalizeVisibleCompare(prevText);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const words = (s: string) => s.split(/\s+/).filter((w) => w.length >= 4);
  const aw = words(a);
  const bw = words(b);
  if (!bw.length) return false;
  let hit = 0;
  for (const w of bw) {
    if (aw.some((x) => x.includes(w) || w.includes(x))) hit++;
  }
  return hit / bw.length >= 0.45;
}
