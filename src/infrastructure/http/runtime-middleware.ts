/**
 * AgentRuntime 全局中间件装配（CORS / 日志 / 限流 / body / 压缩 / helmet）
 * 由 AgentRuntime 薄包装委托。
 */
// @ts-expect-error compression 无类型声明
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
// @ts-expect-error express 无 @types/express（与仓库约定一致）
import express from 'express';
import chalk from 'chalk';
import RuntimeUtil from '#utils/runtime-util.js';
import runtimeConfig from '#infrastructure/config/config.js';
import FrontendLauncher from '#infrastructure/frontend/launcher.js';
import {
  resolveRequestId,
  enterRequestContext,
} from '#utils/observability.js';
import { createHttpRequestMetricsMiddleware } from '#utils/http-request-metrics.js';
import { attachChaosMiddleware } from '#infrastructure/http/runtime-chaos.js';
import * as runtimeObs from '#infrastructure/http/runtime-observability.js';
import {
  isPrivateOrLoopbackAddress,
} from '#infrastructure/http/auth.js';

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type ExpressReq = {
  requestId?: string;
  path?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  hostname?: string;
  ip?: string;
  multipartUpload?: unknown;
  createMultipartUploader?: (options?: Record<string, unknown>) => unknown;
  serverLimits?: unknown;
};

type ExpressRes = {
  headersSent?: boolean;
  statusCode?: number;
  setHeader: (name: string, value: string) => unknown;
  header: (name: string, value: string) => unknown;
  sendStatus: (code: number) => unknown;
  redirect: (status: number, url: string) => unknown;
  status: (code: number) => { send: (body: string) => unknown; json: (body: unknown) => unknown };
  writeHead: (...args: unknown[]) => unknown;
  end: (...args: unknown[]) => unknown;
  once: (event: string, cb: () => void) => unknown;
};

type ExpressNext = (err?: unknown) => void;

type ExpressApp = {
  use: (...args: unknown[]) => unknown;
  get: (path: string, handler: (req: ExpressReq, res: ExpressRes) => unknown) => unknown;
};

type MwRuntime = {
  express: ExpressApp;
  multipartUpload: unknown;
  _createMultipartUploader: (options?: Record<string, unknown>) => unknown;
  httpBusiness: { handleRedirect: (req: ExpressReq, res: ExpressRes) => boolean };
  _subserverFileHandler: (req: ExpressReq, res: ExpressRes) => unknown;
  _fileHandler: (req: ExpressReq, res: ExpressRes) => unknown;
  _authMiddleware: (req: ExpressReq, res: ExpressRes, next: ExpressNext) => unknown;
  _checkHeadersSent: (res: ExpressRes, next?: ExpressNext) => boolean;
  _setupMultipartUploader: () => void;
  getWebSocketStats?: () => unknown;
  httpPort?: number | null;
  httpsPort?: number | null;
  actualPort?: number | null;
  actualHttpsPort?: number | null;
  proxyEnabled?: boolean;
  domainConfigs?: { keys: () => IterableIterator<string>; size: number };
};

type FrontendAppInfo = {
  config?: { mountPath?: unknown; id?: unknown };
};

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function initializeMiddlewareAndRoutes(runtime: MwRuntime) {
  let frontendMountPrefixes: string[] = [];
  try {
    const apps = await FrontendLauncher.discover();
    if (apps && apps.size > 0) {
      frontendMountPrefixes = Array.from(apps.values()).flatMap((app) => {
        const cfgApp = (app as FrontendAppInfo)?.config;
        if (!cfgApp) return [];
        const trimmed = typeof cfgApp.mountPath === 'string' ? cfgApp.mountPath.trim() : '';
        return [trimmed || `/${String(cfgApp.id ?? '')}`];
      });
    }
  } catch {
    frontendMountPrefixes = [];
  }

  runtime.express.use((req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
    req.requestId = resolveRequestId(req);
    const traceparent = req.headers?.traceparent;
    enterRequestContext({
      requestId: req.requestId,
      path: req.path,
      method: req.method,
      ...(typeof traceparent === 'string' && traceparent ? { traceparent } : {}),
    });
    if (!res.headersSent && req.requestId) {
      res.setHeader('X-Request-Id', req.requestId);
    }
    next();
  });

  // /xrk、/core：X-Robots-Tag
  runtime.express.use((req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
    const p = req.path || '';
    if (p === '/xrk' || p.startsWith('/xrk/') || p === '/core' || p.startsWith('/core/')) {
      if (!res.headersSent) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      }
    }
    next();
  });

  // 入站 HTTP 延迟聚合（水库采样）→ /metrics.http；与请求日志开关无关
  runtime.express.use(createHttpRequestMetricsMiddleware());

  // 默认关闭；XRK_CHAOS_ENABLED=1 时注入延迟/503
  attachChaosMiddleware(runtime.express);

  const compressionCfg = rec(rec(runtimeConfig.server).compression);
  if (compressionCfg.enabled !== false) {
    runtime.express.use(compression({
      filter: (req: ExpressReq, res: ExpressRes) => {
        if (req.headers?.['x-no-compression']) return false;
        return compression.filter(req, res);
      },
      level: Number(compressionCfg.level) || 6,
      threshold: Number(compressionCfg.threshold) || 1024,
    }));
  }

  const securityCfg = rec(rec(runtimeConfig.server).security);
  const helmetCfg = rec(securityCfg.helmet);
  if (helmetCfg.enabled !== false) {
    const useHttps = rec(rec(runtimeConfig.server).https).enabled === true;
    const hstsCfg = rec(securityCfg.hsts);
    runtime.express.use(helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: useHttps ? { policy: 'same-origin-allow-popups' } : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: hstsCfg.enabled === true ? {
        maxAge: Number(hstsCfg.maxAge) || 31536000,
        includeSubDomains: hstsCfg.includeSubDomains !== false,
        preload: hstsCfg.preload === true,
      } : false,
    }));
  }

  setupCors(runtime);
  setupRequestLogging(runtime);
  setupRateLimiting(runtime);
  setupBodyParsers(runtime);

  runtime.express.use((req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
    req.multipartUpload = runtime.multipartUpload;
    req.createMultipartUploader = (options: Record<string, unknown> = {}) => runtime._createMultipartUploader(options);
    req.serverLimits = rec(runtimeConfig.server).limits || {};
    next();
  });

  runtime.express.use((req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
    const baseSkipPrefixes = ['/api/', '/media/', '/uploads/', '/File', '/core/', '/subserver-file'];
    const reqPath = req.path;
    if (!reqPath || reqPath === '/') return next();
    const redirectSkipPrefixes = baseSkipPrefixes.concat(frontendMountPrefixes || []);
    if (redirectSkipPrefixes.some((p) => reqPath.startsWith(p))) {
      return next();
    }
    if (runtime.httpBusiness.handleRedirect(req, res)) {
      return;
    }
    next();
  });

  runtime.express.get('/status', (req: ExpressReq, res: ExpressRes) =>
    runtimeObs.handleStatus(runtime as any, req, res as any));
  runtime.express.get('/health', (req: ExpressReq, res: ExpressRes) =>
    runtimeObs.handleLiveness(runtime as any, req, res as any));
  runtime.express.get('/subserver-file', (req: ExpressReq, res: ExpressRes) => runtime._subserverFileHandler(req, res));
  runtime.express.get('/metrics', (req: ExpressReq, res: ExpressRes) =>
    runtimeObs.handleMetrics(runtime as any, req, res as any));

  const { setupDataStaticServing, setupStaticServing, handleRobotsTxt, handleFavicon } = await import('#infrastructure/http/runtime-static.js');
  runtime.express.get('/robots.txt', (req: ExpressReq, res: ExpressRes) => handleRobotsTxt(runtime as any, req, res as any));
  runtime.express.get('/favicon.ico', (req: ExpressReq, res: ExpressRes) => handleFavicon(runtime as any, req, res as any));

  runtime.express.use('/File', (req: ExpressReq, res: ExpressRes) => runtime._fileHandler(req, res));
  runtime.express.use((req: ExpressReq, res: ExpressRes, next: ExpressNext) => runtime._authMiddleware(req, res, next));

  setupDataStaticServing(runtime as any);
  await setupStaticServing(runtime as any);
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function setupCors(runtime: MwRuntime) {
  const corsConfig = rec(rec(runtimeConfig.server).cors);
  if (corsConfig.enabled === false) return;

  runtime.express.use((req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
    if (runtime._checkHeadersSent(res, next)) return;

    const config = corsConfig;
    const allowedOrigins = Array.isArray(config.origins)
      ? config.origins.map(String)
      : ['*'];
    const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : undefined;
    const exposeHeaders = Array.isArray(config.exposeHeaders) && config.exposeHeaders.length
      ? config.exposeHeaders.map(String).join(', ')
      : 'X-Request-Id, X-Response-Time';
    const allowMethods = Array.isArray(config.methods)
      ? config.methods.map(String).join(', ')
      : 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD';
    const allowHeaders = Array.isArray(config.headers)
      ? config.headers.map(String).join(', ')
      : 'Content-Type, Authorization, X-API-Key, X-User-Email, X-Requested-With, traceparent, tracestate';

    if (req.method === 'OPTIONS') {
      if (allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }
      res.header('Access-Control-Allow-Methods',
        allowMethods);
      res.header('Access-Control-Allow-Headers',
        allowHeaders);
      res.header('Access-Control-Allow-Credentials',
        config.credentials ? 'true' : 'false');
      res.header('Access-Control-Max-Age',
        String(config.maxAge || 86400));
      res.header('Access-Control-Expose-Headers',
        exposeHeaders);
      return res.sendStatus(204);
    }

    if (allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))) {
      res.header('Access-Control-Allow-Origin', origin || '*');
    }

    res.header('Access-Control-Allow-Methods',
      allowMethods);
    res.header('Access-Control-Allow-Headers',
      allowHeaders);
    res.header('Access-Control-Allow-Credentials',
      config.credentials ? 'true' : 'false');
    res.header('Access-Control-Expose-Headers',
      exposeHeaders);

    if (config.maxAge) {
      res.header('Access-Control-Max-Age', String(config.maxAge));
    }

    next();
  });
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function setupRequestLogging(runtime: MwRuntime) {
  const loggingCfg = rec(rec(runtimeConfig.server).logging);
  if (loggingCfg.requests === false) return;

  runtime.express.use((req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
    const start = Date.now();

    if (!res.headersSent && req.requestId) {
      res.setHeader('X-Request-Id', req.requestId);
    }

    res.once('finish', () => {
      const duration = Date.now() - start;
      const quietPaths = Array.isArray(loggingCfg.quiet) ? loggingCfg.quiet.map(String) : [];
      const reqPath = req.path || '';
      if (!quietPaths.some((p) => reqPath.startsWith(p))) {
        const statusColor = (res.statusCode || 0) < 400 ? 'green'
          : (res.statusCode || 0) < 500 ? 'yellow' : 'red';
        const method = chalk.cyan((req.method || '').padEnd(6));
        const statusFn = statusColor === 'green' ? chalk.green : statusColor === 'yellow' ? chalk.yellow : chalk.red;
        const status = statusFn(res.statusCode);
        const time = chalk.gray(`${duration}ms`.padStart(7));
        const pathStr = chalk.white(reqPath);
        const host = req.hostname ? chalk.gray(` [${req.hostname}]`) : '';
        const requestId = chalk.gray(` [${req.requestId}]`);
        RuntimeUtil.makeLog('debug', `${method} ${status} ${time} ${pathStr}${host}${requestId}`, 'HTTP');
      }
    });

    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (...args: unknown[]) => {
      const duration = Date.now() - start;
      if (!res.headersSent) {
        res.setHeader('X-Response-Time', `${duration}ms`);
      }
      return originalWriteHead(...args);
    };

    const originalEnd = res.end.bind(res);
    res.end = (...args: unknown[]) => {
      const duration = Date.now() - start;
      if (!res.headersSent) {
        res.setHeader('X-Response-Time', `${duration}ms`);
      }
      return originalEnd(...args);
    };

    next();
  });
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function setupRateLimiting(runtime: MwRuntime) {
  const rateLimitConfig = rec(rec(runtimeConfig.server).rateLimit);
  if (rateLimitConfig.enabled === false) return;

  const createLimiter = (options: Record<string, unknown>) => rateLimit({
    windowMs: Number(options.windowMs) || 15 * 60 * 1000,
    max: Number(options.max) || 100,
    message: typeof options.message === 'string' ? options.message : '请求过于频繁',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req: { ip?: string }) => isPrivateOrLoopbackAddress(req.ip),
  });

  if (rateLimitConfig.global) {
    runtime.express.use(createLimiter(rec(rateLimitConfig.global)));
  }
  if (rateLimitConfig.api) {
    runtime.express.use('/api', createLimiter(rec(rateLimitConfig.api)));
  }
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function setupBodyParsers(runtime: MwRuntime) {
  const limits = rec(rec(runtimeConfig.server).limits);
  const limitOf = (key: string, fallback: string) =>
    typeof limits[key] === 'string' || typeof limits[key] === 'number' ? limits[key] : fallback;

  runtime.express.use(express.urlencoded({
    extended: false,
    limit: limitOf('urlencoded', '10mb'),
  }));
  runtime.express.use(express.json({
    limit: limitOf('json', '10mb'),
  }));
  runtime.express.use(express.raw({
    limit: limitOf('raw', '10mb'),
  }));
  runtime.express.use(express.text({
    type: ['text/*', 'application/xml'],
    limit: limitOf('text', '10mb'),
  }));

  runtime._setupMultipartUploader();
}
