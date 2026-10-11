/**
 * 生成给当前请求方用的基址（下载/预览 URL）。
 * 优先 Host（及 X-Forwarded-Proto），避免配置里是 127.0.0.1 时公网客户端拿到不可达链接。
 */

type RequestLike = {
  get?: (name: string) => string | undefined;
  headers?: Record<string, string | string[] | undefined>;
  protocol?: string;
};

type RuntimeLike = {
  url?: string;
  getServerUrl?: () => string;
};

export function resolveClientBaseUrl(req: RequestLike | null | undefined, runtime?: RuntimeLike | null): string {
  const hostHeader = req?.get?.('host') || req?.headers?.host;
  if (hostHeader && req) {
    const hostStr = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    const xf = req.get?.('x-forwarded-proto') || req.headers?.['x-forwarded-proto'];
    const xfStr = Array.isArray(xf) ? xf[0] : xf;
    const proto = String(xfStr || req.protocol || 'http')
      .split(',')[0]
      .trim()
      .replace(/:$/, '') || 'http';
    return `${proto}://${hostStr}`.replace(/\/+$/, '');
  }
  const raw = runtime?.url || runtime?.getServerUrl?.() || 'http://127.0.0.1';
  return String(raw).replace(/\/+$/, '');
}
