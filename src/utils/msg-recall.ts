/**
 * 消息定时撤回（模块级定时器）
 *
 * 首选：reply(msg, quote, { recallMsg: 秒 }) — loader-deal 发完即 schedule。
 * 手工：scheduleMsgRecall(e, ids, { delayMs })（少数需要批量时）。
 *
 * NapCat：send_msg → data.message_id；delete_msg → { message_id }。
 */
import { normalizeError } from '#utils/normalize-error.js';

type LoggerLike = {
  warn: (msg: string) => void;
  info: (msg: string) => void;
};

function getLogger(): LoggerLike {
  return (globalThis as { logger?: LoggerLike }).logger ?? {
    warn: () => {},
    info: () => {},
  };
}

const _timers = new Set<ReturnType<typeof setTimeout>>();
const RECALL_GAP_MS = 200;

export function extractMsgIds(msgRes: unknown): number[] {
  if (msgRes == null || msgRes === false) return [];

  const out: number[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (raw == null || raw === '') return;
    if (typeof raw === 'object') return;
    const id = Number(raw);
    if (!Number.isFinite(id)) return;
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(id);
  };
  const take = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) push(x);
    else push(v);
  };

  const res = msgRes as { message_id?: unknown; data?: unknown };
  take(res.message_id);
  const data = res.data;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') take((item as { message_id?: unknown }).message_id);
    }
  } else if (data && typeof data === 'object') {
    take((data as { message_id?: unknown }).message_id);
  }

  return out;
}

type RecallEvent = {
  _sentMsgIds?: number[];
  isGroup?: boolean;
  group?: { recallMsg?: (id: number) => unknown };
  friend?: { recallMsg?: (id: number) => unknown };
};

export function rememberSentMsgIds(e: RecallEvent | null | undefined, msgRes: unknown): number[] {
  const ids = extractMsgIds(msgRes);
  if (!e || !ids.length) return ids;
  const bucket = (e._sentMsgIds ||= []);
  for (const id of ids) {
    if (!bucket.some((x) => Number(x) === id)) bucket.push(id);
  }
  return ids;
}

export function scheduleMsgRecall(
  e: RecallEvent | null | undefined,
  msgIds: Array<string | number> | null | undefined,
  opts: {
    delayMs?: number;
    alsoRecall?: Array<string | number>;
    logTag?: string;
  } = {},
): boolean {
  const delayMs = Number(opts.delayMs) > 0 ? Number(opts.delayMs) : 120_000;
  const logTag = opts.logTag || 'MsgRecall';
  const extra = Array.isArray(opts.alsoRecall) ? opts.alsoRecall : [];
  const seen = new Set<string>();
  const ids: number[] = [];
  for (const raw of [...(msgIds || []), ...extra]) {
    const id = Number(raw);
    if (!Number.isFinite(id)) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }

  if (!e || !ids.length) return false;

  const target = e.isGroup ? e.group : e.friend;
  if (!target?.recallMsg) {
    getLogger().warn(`[${logTag}] 无法定时撤回：缺少 group/friend.recallMsg`);
    return false;
  }

  const timer = setTimeout(() => {
    _timers.delete(timer);
    void (async () => {
      let ok = 0;
      for (let i = 0; i < ids.length; i++) {
        try {
          await Promise.resolve(target.recallMsg!(ids[i]!));
          ok += 1;
        } catch (err) {
          getLogger().warn(`[${logTag}] 撤回失败 msgId=${ids[i]}: ${normalizeError(err).message}`);
        }
        if (i < ids.length - 1) await new Promise((r) => setTimeout(r, RECALL_GAP_MS));
      }
      getLogger().info(`[${logTag}] 定时撤回完成 ok=${ok}/${ids.length}`);
    })();
  }, delayMs);

  _timers.add(timer);
  getLogger().info(`[${logTag}] 已安排 ${ids.length} 条 ${Math.round(delayMs / 1000)}s 后撤回`);
  return true;
}

export function clearPendingMsgRecalls(): void {
  for (const timer of _timers) clearTimeout(timer);
  _timers.clear();
}
