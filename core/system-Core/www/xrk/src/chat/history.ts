/**
 * 聊天历史 localStorage（对齐原 app._loadChatHistory / _saveChatHistory）
 * 键名保持兼容：aiChatHistory / eventChatHistory / voiceChatHistory
 */
import { randomId } from '@/utils/http';
import { segmentsToPlainText } from '@/chat/segments';
import type {
  ChatMode,
  HistoryItem,
  LoosePayload,
  MakeHistoryOptions,
  NormalizedSegment,
} from '@/types';

export const MAX_HISTORY = 200;

export function historyStorageKey(mode?: ChatMode | string): string {
  const m = mode || 'event';
  if (m === 'ai') return 'aiChatHistory';
  if (m === 'voice') return 'voiceChatHistory';
  return 'eventChatHistory';
}

/** 规范化一条历史消息（兼容 text / content / segments） */
export function normalizeHistoryItem(raw: LoosePayload): HistoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const role = raw.role || (raw.type === 'image' ? 'assistant' : '');
  if (!role) return null;

  let segments: NormalizedSegment[] | null = Array.isArray(raw.segments)
    ? (raw.segments.filter(Boolean) as NormalizedSegment[])
    : null;
  if ((!segments || !segments.length) && raw.type === 'image' && raw.url) {
    segments = [{ type: 'image', url: raw.url }];
  }
  if ((!segments || !segments.length) && (raw.text || raw.content)) {
    const text = String(raw.text ?? raw.content ?? '');
    if (text) segments = [{ type: 'text', text }];
  }

  const text =
    (typeof raw.text === 'string' && raw.text) ||
    (typeof raw.content === 'string' && raw.content) ||
    segmentsToPlainText(segments) ||
    '';

  const item = {
    id: raw.id || randomId('msg'),
    role,
    text,
    content: text,
    segments: segments || (text ? [{ type: 'text', text }] : []),
    ts: Number(raw.ts) || Date.now(),
  } as HistoryItem;
  if (raw.mcpTools) item.mcpTools = raw.mcpTools;
  if (raw.source) item.source = raw.source;
  if (raw.type === 'record' || raw.type === 'chat-record') {
    item.type = 'record';
    item.title = raw.title || '';
    item.description = raw.description || '';
    item.messages = raw.messages || [];
  }
  return item;
}

export function loadChatHistory(mode?: ChatMode | string): HistoryItem[] {
  try {
    const raw = localStorage.getItem(historyStorageKey(mode));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((entry) => normalizeHistoryItem(entry as LoosePayload))
      .filter((x): x is HistoryItem => Boolean(x))
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  } catch (e) {
    console.warn('[聊天历史] 加载失败:', e);
    return [];
  }
}

export function saveChatHistory(mode: ChatMode | string, history: HistoryItem[]): void {
  try {
    const list = Array.isArray(history) ? history.slice(-MAX_HISTORY) : [];
    const toSave = list
      .filter((m) => m && m.role && m.role !== 'system')
      .map((m) => {
        const item = {
          id: m.id || randomId('msg'),
          role: m.role,
          ts: m.ts || Date.now(),
        } as HistoryItem;
        if (Array.isArray(m.segments) && m.segments.length) {
          item.segments = m.segments;
          item.text = m.text || m.content || segmentsToPlainText(m.segments);
        } else {
          item.text = m.text || m.content || '';
        }
        if (m.mcpTools) item.mcpTools = m.mcpTools;
        if (m.source) item.source = m.source;
        if (m.type === 'record') {
          item.type = 'record';
          item.title = m.title || '';
          item.description = m.description || '';
          item.messages = m.messages || [];
        }
        return item;
      });
    localStorage.setItem(historyStorageKey(mode), JSON.stringify(toSave));
  } catch (e) {
    console.warn('[聊天历史] 保存失败:', e);
  }
}

export function clearChatHistoryStorage(mode?: ChatMode | string): void {
  try {
    localStorage.removeItem(historyStorageKey(mode));
  } catch {
    /* ignore */
  }
}

export function makeHistoryMessage(
  role: string,
  { text = '', segments = null, extra = {} }: MakeHistoryOptions = {},
): HistoryItem {
  const segs: NormalizedSegment[] =
    Array.isArray(segments) && segments.length
      ? segments
      : text
        ? [{ type: 'text', text: String(text) }]
        : [];
  const plain = text || segmentsToPlainText(segs) || '';
  return {
    id: randomId('msg'),
    role,
    text: plain,
    content: plain,
    segments: segs,
    ts: Date.now(),
    ...extra,
  };
}
