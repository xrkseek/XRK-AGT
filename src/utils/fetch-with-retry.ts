import runtimeConfig from '#infrastructure/config/config.js';
import { ProxyAgent } from 'undici';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeTimeoutMs(v: unknown, fallback: number): number {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

function getDefaultProxyUrl(): string | null {
  const p = (runtimeConfig as { server?: { outbound?: { proxy?: unknown } } })?.server?.outbound?.proxy;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
}

export type FetchPolicyOptions = RequestInit & {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  proxyUrl?: string | null;
};

/**
 * 统一外联请求：超时 + 简单重试 + 可选代理（undici ProxyAgent）
 */
export async function fetchWithPolicy(url: string, options: FetchPolicyOptions = {}): Promise<Response> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, 15_000);
  const retries = Number.isFinite(options.retries) ? Math.max(0, Number(options.retries)) : 1;
  const retryDelayMs = normalizeTimeoutMs(options.retryDelayMs, 500);
  const proxyUrl = Object.hasOwn(options, 'proxyUrl') ? options.proxyUrl : getDefaultProxyUrl();

  const base: FetchPolicyOptions = { ...options };
  delete base.timeoutMs;
  delete base.retries;
  delete base.retryDelayMs;
  delete base.proxyUrl;

  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...base,
        ...(dispatcher ? { dispatcher } : {}),
        signal: base.signal || AbortSignal.timeout(timeoutMs),
      } as RequestInit);
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) break;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}
