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

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function initializeMiddlewareAndRoutes(runtime: any) {
  let frontendMountPrefixes = [];
  try {
    const apps = await FrontendLauncher.discover();
    if (apps && apps.size > 0) {
      frontendMountPrefixes = Array.from(apps.values())
        .map((app: any) => app && app.config)
        .filter(Boolean)
        .map((cfgApp: any) => {
          const mountPath = (cfgApp.mountPath && String(cfgApp.mountPath).trim()) || `/${cfgApp.id}`;
          return mountPath;
        });
    }
  } catch {
    frontendMountPrefixes = [];
  }

  runtime.express.use((req: any, res: any, next: any) => {
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
  runtime.express.use((req: any, res: any, next: any) => {
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

  if (runtimeConfig.server.compression.enabled !== false) {
    runtime.express.use(compression({
      filter: (req: any, res: any) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
      },
      level: runtimeConfig.server.compression.level || 6,
      threshold: runtimeConfig.server.compression.threshold || 1024,
    }));
  }

  if (runtimeConfig.server.security.helmet.enabled !== false) {
    const useHttps = runtimeConfig.server?.https?.enabled === true;
    runtime.express.use(helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: useHttps ? { policy: 'same-origin-allow-popups' } : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: runtimeConfig.server.security.hsts.enabled === true ? {
        maxAge: runtimeConfig.server.security.hsts.maxAge || 31536000,
        includeSubDomains: runtimeConfig.server.security.hsts.includeSubDomains !== false,
        preload: runtimeConfig.server.security.hsts.preload === true,
      } : false,
    }));
  }

  setupCors(runtime);
  setupRequestLogging(runtime);
  setupRateLimiting(runtime);
  setupBodyParsers(runtime);

  runtime.express.use((req: any, res: any, next: any) => {
    req.multipartUpload = runtime.multipartUpload;
    req.createMultipartUploader = (options: any = {}) => runtime._createMultipartUploader(options);
    req.serverLimits = runtimeConfig.server?.limits || {};
    next();
  });

  runtime.express.use((req: any, res: any, next: any) => {
    const baseSkipPrefixes = ['/api/', '/media/', '/uploads/', '/File', '/core/', '/subserver-file'];
    if (!req.path || req.path === '/') return next();
    const redirectSkipPrefixes = baseSkipPrefixes.concat(frontendMountPrefixes || []);
    if (redirectSkipPrefixes.some((p) => req.path.startsWith(p))) {
      return next();
    }
    if (runtime.httpBusiness.handleRedirect(req, res)) {
      return;
    }
    next();
  });

  runtime.express.get('/status', (req: any, res: any) => runtimeObs.handleStatus(runtime, req, res));
  runtime.express.get('/health', (req: any, res: any) => runtimeObs.handleLiveness(runtime, req, res));
  runtime.express.get('/subserver-file', (req: any, res: any) => runtime._subserverFileHandler(req, res));
  runtime.express.get('/metrics', (req: any, res: any) => runtimeObs.handleMetrics(runtime, req, res));

  const { setupDataStaticServing, setupStaticServing, handleRobotsTxt, handleFavicon } = await import('#infrastructure/http/runtime-static.js');
  runtime.express.get('/robots.txt', (req: any, res: any) => handleRobotsTxt(runtime, req, res));
  runtime.express.get('/favicon.ico', (req: any, res: any) => handleFavicon(runtime, req, res));

  runtime.express.use('/File', (req: any, res: any) => runtime._fileHandler(req, res));
  runtime.express.use((req: any, res: any, next: any) => runtime._authMiddleware(req, res, next));

  setupDataStaticServing(runtime);
  await setupStaticServing(runtime);
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function setupCors(runtime: any) {
  const corsConfig = runtimeConfig.server.cors;
  if (corsConfig.enabled === false) return;

  runtime.express.use((req: any, res: any, next: any) => {
    if (runtime._checkHeadersSent(res, next)) return;

    const config = corsConfig || {};
    const allowedOrigins = config.origins || ['*'];
    const origin = req.headers.origin;
    const exposeHeaders = Array.isArray(config.exposeHeaders) && config.exposeHeaders.length
      ? config.exposeHeaders.join(', ')
      : 'X-Request-Id, X-Response-Time';

    if (req.method === 'OPTIONS') {
      if (allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }
      res.header('Access-Control-Allow-Methods',
        config.methods?.join(', ') || 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
      res.header('Access-Control-Allow-Headers',
        config.headers?.join(', ') || 'Content-Type, Authorization, X-API-Key, X-User-Email, X-Requested-With, traceparent, tracestate');
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
      config.methods?.join(', ') || 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
    res.header('Access-Control-Allow-Headers',
      config.headers?.join(', ') || 'Content-Type, Authorization, X-API-Key, X-User-Email, X-Requested-With, traceparent, tracestate');
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
export function setupRequestLogging(runtime: any) {
  if (runtimeConfig.server.logging.requests === false) return;

  runtime.express.use((req: any, res: any, next: any) => {
    const start = Date.now();

    if (!res.headersSent) {
      res.setHeader('X-Request-Id', req.requestId);
    }

    res.once('finish', () => {
      const duration = Date.now() - start;
      const quietPaths = runtimeConfig.server.logging.quiet || [];
      if (!quietPaths.some((p: any) => req.path.startsWith(p))) {
        const statusColor = res.statusCode < 400 ? 'green'
          : res.statusCode < 500 ? 'yellow' : 'red';
        const method = chalk.cyan(req.method.padEnd(6));
        const status = chalk[statusColor](res.statusCode);
        const time = chalk.gray(`${duration}ms`.padStart(7));
        const pathStr = chalk.white(req.path);
        const host = req.hostname ? chalk.gray(` [${req.hostname}]`) : '';
        const requestId = chalk.gray(` [${req.requestId}]`);
        RuntimeUtil.makeLog('debug', `${method} ${status} ${time} ${pathStr}${host}${requestId}`, 'HTTP');
      }
    });

    const originalWriteHead = res.writeHead;
    res.writeHead = function (...args: any) {
      const duration = Date.now() - start;
      if (!res.headersSent) {
        res.setHeader('X-Response-Time', `${duration}ms`);
      }
      return originalWriteHead.apply(this, args);
    };

    const originalEnd = res.end;
    res.end = function (chunk: any, encoding: any, callback: any) {
      const duration = Date.now() - start;
      if (!res.headersSent) {
        res.setHeader('X-Response-Time', `${duration}ms`);
      }
      return originalEnd.call(this, chunk, encoding, callback);
    };

    next();
  });
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function setupRateLimiting(runtime: any) {
  const rateLimitConfig = runtimeConfig.server.rateLimit;
  if (rateLimitConfig.enabled === false) return;

  const createLimiter = (options: any) => rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000,
    max: options.max || 100,
    message: options.message || '请求过于频繁',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req: any) => isPrivateOrLoopbackAddress(req.ip),
  });

  if (rateLimitConfig?.global) {
    runtime.express.use(createLimiter(rateLimitConfig.global));
  }
  if (rateLimitConfig?.api) {
    runtime.express.use('/api', createLimiter(rateLimitConfig.api));
  }
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function setupBodyParsers(runtime: any) {
  const limits = runtimeConfig.server.limits || {};

  runtime.express.use(express.urlencoded({
    extended: false,
    limit: limits.urlencoded || '10mb',
  }));
  runtime.express.use(express.json({
    limit: limits.json || '10mb',
  }));
  runtime.express.use(express.raw({
    limit: limits.raw || '10mb',
  }));
  runtime.express.use(express.text({
    type: ['text/*', 'application/xml'],
    limit: limits.text || '10mb',
  }));

  runtime._setupMultipartUploader();
}
