/**
 * 入站 HTTP 延迟聚合
 * 水库采样 + 滑动错误窗口；导出至 `/metrics.http` 与 Prometheus。
 */
import { LatencyHistogram, type LatencyRecord, type LatencySummary } from '#utils/metrics-stats.js';

const DEFAULT_RESERVOIR = 8_000;
const DEFAULT_SLIDING = 500;

let hist: LatencyHistogram | null = null;
let startedAt = 0;

function ensure(): LatencyHistogram {
  if (!hist) {
    hist = new LatencyHistogram({
      reservoirSize: DEFAULT_RESERVOIR,
      slidingWindow: DEFAULT_SLIDING,
    });
    hist.begin();
    startedAt = Date.now();
  }
  return hist;
}

/** 测试用：重置全局直方图 */
export function resetHttpRequestMetrics(): void {
  hist = null;
  startedAt = 0;
}

export function recordHttpRequest(row: LatencyRecord): void {
  ensure().record(row);
}

export function getHttpRequestMetricsSummary(): LatencySummary & { startedAt: number } {
  const h = ensure();
  return { ...h.summary(), startedAt };
}

type ExpressLikeReq = { path?: string };
type ExpressLikeRes = { statusCode?: number; once: (event: string, cb: () => void) => unknown };
type ExpressLikeNext = (err?: unknown) => void;
type ExpressLikeHandler = (req: ExpressLikeReq, res: ExpressLikeRes, next: ExpressLikeNext) => void;

/**
 * Express 中间件：在 `finish` 时记录延迟（默认跳过 `/metrics`）
 */
export function createHttpRequestMetricsMiddleware(
  opts: { skipPaths?: string[] } = {},
): ExpressLikeHandler {
  const skip = opts.skipPaths || ['/metrics'];
  return function httpRequestMetricsMiddleware(req, res, next) {
    const t0 = performance.now();
    res.once('finish', () => {
      const reqPath = req.path || '';
      if (skip.some((p) => reqPath === p || reqPath.startsWith(`${p}/`))) return;
      const ms = performance.now() - t0;
      const status = res.statusCode || 0;
      const ok = status >= 200 && status < 500;
      recordHttpRequest({ ok, ms, status });
    });
    next();
  };
}
