/**
 * AgentRuntime 存活/指标/状态 HTTP 处理（从 agent-runtime 拆出，降 Facade 集中度）
 */
import { HttpResponse } from '#utils/http-utils.js';
import MonitorService from '#infrastructure/ai-workflow/monitor-service.js';
import runtimeConfig from '#infrastructure/config/config.js';
import {
  buildProcessMetrics,
  formatPrometheusMetrics,
} from '#utils/observability.js';
import { getHttpRequestMetricsSummary } from '#utils/http-request-metrics.js';

type ExpressLikeReq = {
  requestId?: string | null;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
};

type ExpressLikeRes = {
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => { send: (body: string) => unknown };
};

type RuntimeLike = {
  _checkHeadersSent: (res: ExpressLikeRes) => boolean;
  httpPort?: number;
  httpsPort?: number;
  actualPort?: number;
  actualHttpsPort?: number;
  proxyEnabled?: boolean;
  domainConfigs?: { keys: () => IterableIterator<string> };
  getWebSocketStats: () => unknown;
};

export function handleLiveness(
  runtime: RuntimeLike,
  req: ExpressLikeReq,
  res: ExpressLikeRes,
): unknown {
  if (runtime._checkHeadersSent(res)) return;
  return HttpResponse.json(res as any, {
    status: '健康',
    uptime: process.uptime(),
    timestamp: Date.now(),
    requestId: req.requestId || null,
  });
}

export function handleStatus(
  runtime: RuntimeLike,
  _req: ExpressLikeReq,
  res: ExpressLikeRes,
): unknown {
  if (runtime._checkHeadersSent(res)) return;

  const status = {
    status: '运行中',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    timestamp: Date.now(),
    version: process.version,
    platform: process.platform,
    server: {
      httpPort: runtime.httpPort,
      httpsPort: runtime.httpsPort,
      actualPort: runtime.actualPort,
      actualHttpsPort: runtime.actualHttpsPort,
      https: (runtimeConfig as any).server?.https?.enabled || false,
      proxy: runtime.proxyEnabled,
      domains: runtime.proxyEnabled ? Array.from(runtime.domainConfigs?.keys() ?? []) : [],
    },
    auth: {
      apiKeyEnabled: (runtimeConfig as any).server?.auth?.apiKey?.enabled !== false,
      loopbackExempt: (runtimeConfig as any).server?.auth?.loopbackExempt === true,
    },
  };

  return HttpResponse.json(res as any, status);
}

export function handleMetrics(
  runtime: RuntimeLike,
  req: ExpressLikeReq,
  res: ExpressLikeRes,
): unknown {
  if (runtime._checkHeadersSent(res)) return;

  const metrics = buildProcessMetrics({
    getWebSocketStats: () => runtime.getWebSocketStats(),
    getTraceSummary: () => (MonitorService as any).getTraceSummary(),
    httpPort: runtime.httpPort,
    httpsPort: runtime.httpsPort,
    actualPort: runtime.actualPort,
    actualHttpsPort: runtime.actualHttpsPort,
    proxyEnabled: runtime.proxyEnabled,
    http: getHttpRequestMetricsSummary(),
  });

  const wantProm =
    String(req.query?.format || '').toLowerCase() === 'prometheus' ||
    String(req.headers?.accept || '').includes('text/plain');

  if (wantProm) {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(formatPrometheusMetrics(metrics));
    return;
  }

  return HttpResponse.json(res as any, metrics);
}
