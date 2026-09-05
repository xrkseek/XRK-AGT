/**
 * 服务端混沌注入（默认关闭）
 *
 * 环境变量：
 * - `XRK_CHAOS_ENABLED=1`
 * - `XRK_CHAOS_LATENCY_MS` 指数分布均值（截断到 3×）
 * - `XRK_CHAOS_ERROR_RATE` 0–1，随机 503
 * - `XRK_CHAOS_PATHS` 逗号分隔路径前缀（默认 `/health,/metrics`）
 * - `XRK_CHAOS_SEED` 可选，固定种子可复现
 */
import { createRng, exponentialDelayMs } from '#utils/prng.js';

type ExpressLikeReq = { path?: string; requestId?: string | null };
type ExpressLikeRes = {
  headersSent?: boolean;
  status: (code: number) => { json: (body: unknown) => unknown };
};
type ExpressLikeNext = (err?: unknown) => void;
type ExpressLikeApp = {
  use: (
    handler: (req: ExpressLikeReq, res: ExpressLikeRes, next: ExpressLikeNext) => unknown,
  ) => unknown;
};

function isEnabled(): boolean {
  return process.env.XRK_CHAOS_ENABLED === '1';
}

function parsePaths(): string[] {
  const raw = process.env.XRK_CHAOS_PATHS || '/health,/metrics';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function attachChaosMiddleware(app: ExpressLikeApp): void {
  if (!isEnabled()) return;

  const latencyMean = Math.max(0, Number(process.env.XRK_CHAOS_LATENCY_MS || 0) || 0);
  const latencyCap = latencyMean > 0 ? Math.max(latencyMean, Math.floor(latencyMean * 3)) : 0;
  const errorRate = Math.min(1, Math.max(0, Number(process.env.XRK_CHAOS_ERROR_RATE || 0) || 0));
  const paths = parsePaths();
  const rng = createRng(process.env.XRK_CHAOS_SEED);

  app.use(async (req, res, next) => {
    const hit = paths.some((p) => req.path === p || (req.path ?? '').startsWith(p));
    if (!hit) return next();

    if (latencyMean > 0) {
      const wait = exponentialDelayMs(latencyMean, latencyCap, rng);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }

    if (errorRate > 0 && rng() < errorRate) {
      if (!res.headersSent) {
        res.status(503).json({
          success: false,
          error: 'chaos_injected',
          requestId: req.requestId || null,
        });
      }
      return;
    }

    next();
  });
}

export function chaosEnabled(): boolean {
  return isEnabled();
}
