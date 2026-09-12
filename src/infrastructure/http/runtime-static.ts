/**
 * AgentRuntime 静态资源 / 目录索引 / favicon / robots
 * 由 AgentRuntime 薄包装委托。
 */
import path from 'path';
import * as fsSync from 'fs';
// @ts-expect-error express 无 @types/express（与仓库约定一致）
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import RuntimeUtil from '#utils/runtime-util.js';
import runtimeConfig from '#infrastructure/config/config.js';
import paths from '#utils/paths.js';
import FrontendLauncher from '#infrastructure/frontend/launcher.js';
import { normalizeError } from '#utils/normalize-error.js';

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type HiddenMatcher =
  | { type: 'regex'; value: RegExp }
  | { type: 'includes'; value: string };

type ExpressReq = {
  path?: string;
  method?: string;
  originalUrl?: string;
  staticRoot?: string;
};

type ExpressRes = {
  headersSent?: boolean;
  setHeader: (name: string, value: string) => unknown;
  set?: (headers: Record<string, string> | string, value?: string) => unknown;
  status: (code: number) => ExpressRes;
  json: (body: unknown) => unknown;
  redirect: (status: number, url: string) => unknown;
  sendFile: (filePath: string) => unknown;
  send: (body: string) => unknown;
  end: () => unknown;
};

type ExpressNext = (err?: unknown) => void;

type StaticRuntime = {
  express: { use: (...args: unknown[]) => unknown };
  wwwMountPaths?: string[];
  _checkHeadersSent: (res: ExpressRes, next?: ExpressNext) => boolean;
  httpBusiness: {
    handleCDN: (req: { headers: Record<string, string | string[] | undefined> }, res: ExpressRes, filePath: string) => unknown;
  };
  _compiledHiddenFileMatchers?: HiddenMatcher[] | null;
  getServerUrl: () => string;
};

type FrontendAppInfo = {
  config?: {
    id?: unknown;
    mountPath?: unknown;
    port?: unknown;
  };
};

function staticYaml(): Record<string, unknown> {
  return rec(rec(runtimeConfig.server).static);
}

export function setupDataStaticServing(runtime: StaticRuntime) {
  const dataCacheTime = staticYaml().dataCacheTime || '1h';
  const staticOptions = {
    dotfiles: 'deny' as const,
    fallthrough: false,
    maxAge: dataCacheTime,
    etag: true,
    lastModified: true,
    setHeaders: (res: ExpressRes, filePath: string) => {
      if (!res.headersSent) {
        setStaticHeaders(runtime, res, filePath);
      }
    },
  };

  const mediaDir = path.join(paths.data, 'media');
  runtime.express.use('/media', (req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
    if (runtime._checkHeadersSent(res, next)) return;
    express.static(mediaDir, staticOptions)(req, res, next);
  });

  const uploadsDir = path.join(paths.data, 'uploads');
  runtime.express.use('/uploads', (req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
    if (runtime._checkHeadersSent(res, next)) return;
    express.static(uploadsDir, staticOptions)(req, res, next);
  });
}

export function createStaticOptions(runtime: StaticRuntime) {
  const cfg = staticYaml();
  return {
    index: Array.isArray(cfg.index) ? cfg.index.map(String) : ['index.html', 'index.htm'],
    dotfiles: 'deny' as const,
    extensions: cfg.extensions || false,
    fallthrough: true,
    maxAge: cfg.cacheTime || '1d',
    etag: true,
    lastModified: true,
    immutable: cfg.immutable !== false,
    setHeaders: (res: ExpressRes, filePath: string) => {
      if (!res.headersSent) {
        setStaticHeaders(runtime, res, filePath);
      }
    },
  };
}

export async function setupStaticServing(runtime: StaticRuntime) {
  try {
    const apps = await FrontendLauncher.start();
    if (apps && apps.size > 0) {
      const devApps = Array.from(apps.values()).filter(
        (app): app is any => Boolean(app && (app as FrontendAppInfo).config),
      );

      for (const appInfo of devApps) {
        const cfgApp = appInfo.config;
        if (!cfgApp) continue;
        const appId = String(cfgApp.id ?? '');
        const trimmed = typeof cfgApp.mountPath === 'string' ? cfgApp.mountPath.trim() : '';
        const mountPath = trimmed || `/${appId}`;
        const defaultPort = cfgApp.port;

        const mountPrefix = mountPath.endsWith('/')
          ? mountPath.slice(0, -1)
          : mountPath;

        const devProxy = createProxyMiddleware({
          target: `http://127.0.0.1:${defaultPort}`,
          router: () => {
            const port = FrontendLauncher.getRuntimePort(appId) ?? defaultPort;
            return `http://127.0.0.1:${port}`;
          },
          changeOrigin: true,
          ws: true,
          logLevel: 'warn',
          pathRewrite: (pathReq: string) => {
            if (!pathReq) return `${mountPrefix}/`;
            if (pathReq === '/') return `${mountPrefix}/`;
            if (pathReq.startsWith('/')) return `${mountPrefix}${pathReq}`;
            return `${mountPrefix}/${pathReq}`;
          },
        } as Parameters<typeof createProxyMiddleware>[0]);

        runtime.express.use(mountPath, (req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
          RuntimeUtil.makeLog(
            'debug',
            `[前端入口] id=${appId} mount=${mountPath} ${req.method} ${req.originalUrl}`,
            'Frontend',
          );
          return devProxy(req, res, next);
        });

        RuntimeUtil.makeLog(
          'info',
          `注册前端开发入口: ${mountPath} -> http://127.0.0.1:${defaultPort}`,
          'Frontend',
        );
      }
    }
  } catch (e: unknown) {
    RuntimeUtil.makeLog('warn', `初始化前端开发代理失败: ${normalizeError(e).message}`, 'Frontend');
  }

  runtime.express.use((req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
    if (runtime._checkHeadersSent(res, next)) return;
    directoryIndexMiddleware(runtime, req, res, next);
  });

  runtime.express.use((req: ExpressReq, res: ExpressRes, next: ExpressNext) =>
    staticSecurityMiddleware(runtime, req, res, next),
  );

  const staticOptions = createStaticOptions(runtime);
  const { mountCoreWwwStatic } = await import('#infrastructure/http/mount-core-www.js');
  const mounted = await mountCoreWwwStatic(runtime.express, staticOptions);
  runtime.wwwMountPaths = [...mounted].filter((p) => !String(p).startsWith('/core/'));

  runtime.express.use((req: ExpressReq, res: ExpressRes, next: ExpressNext) => {
    if (runtime._checkHeadersSent(res, next)) return;
    const staticRoot = req.staticRoot || paths.www;
    fsSync.mkdirSync(staticRoot, { recursive: true });
    express.static(staticRoot, staticOptions)(req, res, next);
  });
}

export function directoryIndexMiddleware(
  runtime: StaticRuntime,
  req: ExpressReq,
  res: ExpressRes,
  next: ExpressNext,
) {
  if (res.headersSent) return next();

  const reqPath = req.path || '';
  const hasExtension = path.extname(reqPath);
  if (hasExtension || reqPath.endsWith('/')) {
    return next();
  }

  const staticRoot = req.staticRoot || paths.www;
  const dirPath = path.join(staticRoot, reqPath);

  try {
    const stat = fsSync.statSync(dirPath);
    if (stat.isDirectory()) {
      const indexRaw = staticYaml().index;
      const indexFiles = Array.isArray(indexRaw) ? indexRaw.map(String) : ['index.html', 'index.htm'];
      for (const indexFile of indexFiles) {
        const indexPath = path.join(dirPath, indexFile);
        try {
          if (fsSync.statSync(indexPath).isFile()) {
            const redirectUrl = `${reqPath}/`;
            RuntimeUtil.makeLog('debug', `目录重定向：${reqPath} → ${redirectUrl}`, '服务器');
            if (!res.headersSent) {
              return res.redirect(301, redirectUrl);
            }
            return;
          }
        } catch {
          continue;
        }
      }
    }
  } catch {
    // continue
  }

  next();
}

export function setStaticHeaders(runtime: StaticRuntime, res: ExpressRes, filePath: string) {
  if (runtime._checkHeadersSent(res)) return;

  runtime.httpBusiness.handleCDN({ headers: {} }, res, filePath);

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
  };

  if (runtime._checkHeadersSent(res)) return;

  if (mimeTypes[ext]) {
    res.setHeader('Content-Type', mimeTypes[ext]);
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');

  const cacheConfig = rec(staticYaml().cache);
  const immutableExts = ['.css', '.js', '.woff', '.woff2', '.ttf', '.otf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'];

  if (['.html', '.htm'].includes(ext)) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
  } else if (immutableExts.includes(ext)) {
    const maxAge = cacheConfig.static || 31536000;
    res.setHeader('Cache-Control', `public, max-age=${maxAge}, immutable`);
  } else if (['.json'].includes(ext)) {
    res.setHeader('Cache-Control', `public, max-age=${cacheConfig.static || 3600}`);
  } else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico'].includes(ext)) {
    res.setHeader('Cache-Control', `public, max-age=${cacheConfig.images || 604800}`);
  }
}

export function staticSecurityMiddleware(
  runtime: StaticRuntime,
  req: ExpressReq,
  res: ExpressRes,
  next: ExpressNext,
) {
  if (runtime._checkHeadersSent(res, next)) return;

  const normalizedPath = path.posix.normalize(req.path || '');

  if (normalizedPath.includes('..')) {
    return res.status(403).json({ error: '禁止访问' });
  }

  if (isHiddenStaticPath(runtime, normalizedPath)) {
    return res.status(404).json({ error: '未找到' });
  }

  next();
}

export function isHiddenStaticPath(runtime: StaticRuntime, normalizedPath: string) {
  if (!normalizedPath) return false;
  if (!runtime._compiledHiddenFileMatchers) {
    const raw = rec(rec(runtimeConfig.server).security).hiddenFiles;
    const patterns = (Array.isArray(raw) && raw.length)
      ? raw
      : ['^\\..*', '/\\.', 'node_modules', '\\.git'];

    const compiled: HiddenMatcher[] = [];
    for (const p of patterns) {
      if (p instanceof RegExp) {
        compiled.push({ type: 'regex', value: p });
        continue;
      }
      if (typeof p !== 'string') continue;
      const s = p.trim();
      if (!s) continue;

      const looksLikeRegex = s.startsWith('^') || s.endsWith('$') || s.includes('\\') || s.includes('[') || s.includes('(') || s.includes('|') || s.includes('.*');
      if (looksLikeRegex) {
        try {
          compiled.push({ type: 'regex', value: new RegExp(s) });
          continue;
        } catch {
          // fallback
        }
      }
      compiled.push({ type: 'includes', value: s });
    }
    runtime._compiledHiddenFileMatchers = compiled;
  }

  return runtime._compiledHiddenFileMatchers.some((m) => {
    if (m.type === 'regex') return m.value.test(normalizedPath);
    if (m.type === 'includes') return normalizedPath.includes(m.value);
    return false;
  });
}

export async function handleFavicon(runtime: StaticRuntime, req: ExpressReq, res: ExpressRes) {
  if (runtime._checkHeadersSent(res)) return;

  const staticRoot = req.staticRoot || paths.www;
  const faviconPath = path.join(staticRoot, 'favicon.ico');

  try {
    if (fsSync.statSync(faviconPath).isFile()) {
      if (!res.headersSent) {
        res.set?.({
          'Content-Type': 'image/x-icon',
          'Cache-Control': 'public, max-age=604800',
        });
        return res.sendFile(faviconPath);
      }
      return;
    }
  } catch {
    // 204
  }

  if (!res.headersSent) {
    res.status(204).end();
  }
}

export async function handleRobotsTxt(runtime: StaticRuntime, req: ExpressReq, res: ExpressRes) {
  if (runtime._checkHeadersSent(res)) return;

  const robotsCfg = rec(rec(runtimeConfig.server).robots);
  if (robotsCfg.enabled === false) {
    if (!res.headersSent) res.status(404).end();
    return;
  }

  const staticRoot = req.staticRoot || paths.www;
  const robotsPath = path.join(staticRoot, 'robots.txt');

  try {
    if (fsSync.statSync(robotsPath).isFile()) {
      if (!res.headersSent) {
        res.set?.({
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        });
        return res.sendFile(robotsPath);
      }
      return;
    }
  } catch {
    // default
  }

  const contentOverride = typeof robotsCfg.content === 'string' ? robotsCfg.content.trim() : '';
  const consoleDisallow = ['/xrk', '/xrk/', '/core/'];
  const configuredDisallow = Array.isArray(robotsCfg.disallow) && robotsCfg.disallow.length
    ? robotsCfg.disallow
    : ['/api/', '/config/', '/data/', '/lib/', '/plugins/', '/trash/'];
  const disallow = [...new Set([...configuredDisallow.map(String), ...consoleDisallow])];
  const allow = Array.isArray(robotsCfg.allow)
    ? robotsCfg.allow.map(String).filter((p) => p && p !== '/')
    : [];
  const sitemapPath = String(robotsCfg.sitemapPath || '').trim() || '/sitemap.xml';
  const autoSitemap = robotsCfg.autoSitemap !== false;

  const sitemapUrl = `${runtime.getServerUrl().replace(/\/$/, '')}${sitemapPath.startsWith('/') ? sitemapPath : `/${sitemapPath}`}`;

  let defaultRobots = contentOverride || [
    'User-agent: *',
    ...disallow.map((p) => `Disallow: ${p}`),
    ...allow.map((p) => `Allow: ${p}`),
    '',
  ].join('\n');

  if (contentOverride) {
    const declared = new Set(
      defaultRobots
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean),
    );
    const missing = consoleDisallow.filter(
      (p) => !declared.has(`disallow: ${String(p).toLowerCase()}`),
    );
    if (missing.length) {
      defaultRobots = `${defaultRobots.replace(/\s*$/, '')}\n${missing.map((p) => `Disallow: ${p}`).join('\n')}\n`;
    }
  }

  if (autoSitemap && !/^\s*Sitemap:/mi.test(defaultRobots)) {
    defaultRobots = `${defaultRobots}\nSitemap: ${sitemapUrl}`;
  }

  if (!res.headersSent) {
    res.set?.('Content-Type', 'text/plain; charset=utf-8');
    res.send(defaultRobots);
  }
}
