/**
 * LLM HTTP 错误归一化（对齐 goose/opencode：带 status + Retry-After，供重试层消费）。
 */

export type LlmHttpError = Error & {
  status?: number;
  statusCode?: number;
  code?: string;
  retryAfterMs?: number;
};

type HeaderBag = {
  get?: (name: string) => string | null;
  [key: string]: unknown;
};

type CreateLlmHttpErrorExtra = {
  status?: number;
  statusCode?: number;
  retryAfterMs?: number;
  headers?: HeaderBag | null;
  code?: string;
};

export function createLlmHttpError(
  message: string,
  extra: CreateLlmHttpErrorExtra = {},
): LlmHttpError {
  const err = new Error(message) as LlmHttpError;
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

export function parseStatusFromMessage(message: string): number {
  const m = String(message || '').match(/\b([45]\d{2})\b/);
  return m ? Number(m[1]) : 0;
}

/** @returns 毫秒 */
export function parseRetryAfterMs(headers: HeaderBag | null | undefined): number | null {
  if (!headers) return null;
  const raw =
    typeof headers.get === 'function'
      ? headers.get('retry-after')
      : ((headers['retry-after'] ?? headers['Retry-After']) as string | undefined | null);
  if (raw == null || raw === '') return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.min(120_000, Math.floor(asNum * 1000));
  const when = Date.parse(String(raw));
  if (!Number.isNaN(when)) return Math.min(120_000, Math.max(0, when - Date.now()));
  return null;
}
