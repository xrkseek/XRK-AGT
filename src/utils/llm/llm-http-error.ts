// @ts-nocheck
/**
 * LLM HTTP 错误归一化（对齐 goose/opencode：带 status + Retry-After，供重试层消费）。
 */

/**
 * @param {string} message
 * @param {{ status?: number, statusCode?: number, retryAfterMs?: number, headers?: Headers|Record<string,string>, code?: string }} [extra]
 */
export function createLlmHttpError(message, extra = {}) {
  const err = new Error(message);
  const status = Number(extra.status ?? extra.statusCode) || parseStatusFromMessage(message) || 0;
  if (status) {
    err.status = status;
    err.statusCode = status;
  }
  if (extra.code) err.code = extra.code;
  const fromHeader = extra.retryAfterMs ?? parseRetryAfterMs(extra.headers);
  if (fromHeader != null) err.retryAfterMs = fromHeader;
  return err;
}

/** @param {string} message */
export function parseStatusFromMessage(message) {
  const m = String(message || '').match(/\b([45]\d{2})\b/);
  return m ? Number(m[1]) : 0;
}

/**
 * @param {Headers|Record<string,string>|null|undefined} headers
 * @returns {number|null} 毫秒
 */
export function parseRetryAfterMs(headers) {
  if (!headers) return null;
  const raw = typeof headers.get === 'function'
    ? headers.get('retry-after')
    : (headers['retry-after'] ?? headers['Retry-After']);
  if (raw == null || raw === '') return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.min(120_000, Math.floor(asNum * 1000));
  const when = Date.parse(String(raw));
  if (!Number.isNaN(when)) return Math.min(120_000, Math.max(0, when - Date.now()));
  return null;
}
