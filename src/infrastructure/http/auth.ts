import { HttpResponse } from '#utils/http-utils.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import runtimeConfig from '#infrastructure/config/config.js';

type ExpressLikeReq = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
};

type ExpressLikeRes = {
  headersSent?: boolean;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => { json: (body: unknown) => unknown };
};

/** 规范化 IP / Host（去 IPv6 mapped、zone、端口、方括号） */
export function normalizeIpOrHost(value: unknown): string {
  if (!value || typeof value !== 'string') return '';
  let s = value.toLowerCase().trim();
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  else if (/^[\d.]+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  return s.replace(/^::ffff:/, '').replace(/%.+$/, '');
}

/** 是否 127.* 回环（含 ::ffff:127.*） */
export function isLoopback127Connection(address: unknown): boolean {
  return /^127\./.test(normalizeIpOrHost(address));
}

/** Host 是否本机（localhost / ::1 / 127.*） */
export function isLoopbackHost(hostHeader: unknown): boolean {
  const host = normalizeIpOrHost(String(hostHeader || '').split(',')[0]);
  return Boolean(host) && (host === 'localhost' || host === '::1' || isLoopback127Connection(host));
}

function isNonLoopbackClientIp(ip: unknown): boolean {
  const n = normalizeIpOrHost(ip);
  return Boolean(n) && n !== '::1' && !isLoopback127Connection(n);
}

/**
 * 反代客户端 IP（仅 TCP 已是回环时才应参考，防直连伪造头）。
 */
export function extractProxiedClientAddress(req: ExpressLikeReq | null | undefined): string | null {
  const h = req?.headers || {};
  const xff = h['x-forwarded-for'];
  const xffFirst = typeof xff === 'string' ? xff.split(',')[0] : Array.isArray(xff) ? xff[0] : null;
  for (const raw of [h['cf-connecting-ip'], h['true-client-ip'], h['x-real-ip'], xffFirst]) {
    const ip = normalizeIpOrHost(String(raw || '').trim());
    if (ip) return ip;
  }
  return null;
}

/**
 * 本机回环免 Key 条件（还须 server.auth.loopbackExempt===true 才会生效）。
 * socket=127 但 Host 公网 / 带公网反代头 → 不免。
 */
export function isLoopbackAuthExempt(req: ExpressLikeReq | null | undefined): boolean {
  if (!req) return false;
  if (!isLoopbackHost(req.headers?.host || req.headers?.Host)) return false;
  if (!isLoopback127Connection(req.socket?.remoteAddress || '')) return false;
  if (isNonLoopbackClientIp(extractProxiedClientAddress(req))) return false;
  if (isNonLoopbackClientIp(req.ip)) return false;
  return true;
}

/**
 * 回环或 RFC1918/ULA（限流 skip；鉴权仍只认 127 + loopbackExempt）。
 */
export function isPrivateOrLoopbackAddress(address: unknown): boolean {
  const ip = normalizeIpOrHost(address);
  if (!ip) return false;
  if (ip === 'localhost' || ip === '::1' || isLoopback127Connection(ip)) return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  return /^fe80:/i.test(ip) || /^fc00:/i.test(ip) || /^fd00:/i.test(ip);
}

/** tools.file.runEnabled 时强制 loopback 也要 Key（默认 true） */
export function shouldForceAuthOnLoopbackWhenToolsRun(): boolean {
  if (getAiWorkflowConfigOptional()?.tools?.file?.runEnabled !== true) return false;
  return (runtimeConfig as any).server?.auth?.requireLoopbackAuthWhenToolsRun !== false;
}

/** @returns 未通过时返回 401 响应 */
export function ensureSystemCoreAuth(
  req: ExpressLikeReq,
  res: ExpressLikeRes,
  bot: { checkApiAuthorization?: (req: ExpressLikeReq) => boolean } | null | undefined,
  _context = 'system-Core',
): unknown {
  if (!bot?.checkApiAuthorization?.(req)) {
    return HttpResponse.unauthorized(res as any, '未授权');
  }
}
