/**
 * AgentRuntime 静态资源 / 目录索引 / favicon / robots
 * 由 AgentRuntime 薄包装委托。
 */
import path from 'path';
import * as fsSync from 'fs';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import RuntimeUtil from '#utils/runtime-util.js';
import runtimeConfig from '#infrastructure/config/config.js';
import paths from '#utils/paths.js';
import FrontendLauncher from '#infrastructure/frontend/launcher.js';

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function setupDataStaticServing(runtime) {
  const dataCacheTime = runtimeConfig.server?.static?.dataCacheTime || '1h';
  const staticOptions = {
    dotfiles: 'deny',
    fallthrough: false,
    maxAge: dataCacheTime,
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (!res.headersSent) {
        setStaticHeaders(runtime, res, filePath);
      }
    },
  };

  const mediaDir = path.join(paths.data, 'media');
  runtime.express.use('/media', (req, res, next) => {
    if (runtime._checkHeadersSent(res, next)) return;
    express.static(mediaDir, staticOptions)(req, res, next);
  });

  const uploadsDir = path.join(paths.data, 'uploads');
  runtime.express.use('/uploads', (req, res, next) => {
    if (runtime._checkHeadersSent(res, next)) return;
    express.static(uploadsDir, staticOptions)(req, res, next);
  });
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function createStaticOptions(runtime) {
  return {
    index: runtimeConfig.server.static.index || ['index.html', 'index.htm'],
    dotfiles: 'deny',
    extensions: runtimeConfig.server.static.extensions || false,
    fallthrough: true,
    maxAge: runtimeConfig.server.static.cacheTime || '1d',
    etag: true,
    lastModified: true,
    immutable: runtimeConfig.server.static.immutable !== false,
    setHeaders: (res, filePath) => {
      if (!res.headersSent) {
        setStaticHeaders(runtime, res, filePath);
      }
    },
  };
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function setupStaticServing(runtime) {
  try {
    const apps = await FrontendLauncher.start();
    if (apps && apps.size > 0) {
      const devApps = Array.from(apps.values()).filter((app) => app && app.config);

      for (const appInfo of devApps) {
        const cfgApp = appInfo.config;
        const appId = cfgApp.id;
        const mountPath = (cfgApp.mountPath && String(cfgApp.mountPath).trim()) || `/${appId}`;
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
          pathRewrite: (pathReq) => {
            if (!pathReq) return `${mountPrefix}/`;
            if (pathReq === '/') return `${mountPrefix}/`;
            if (pathReq.startsWith('/')) return `${mountPrefix}${pathReq}`;
            return `${mountPrefix}/${pathReq}`;
          },
        });

        runtime.express.use(mountPath, (req, res, next) => {
          RuntimeUtil.makeLog(
            'debug',
            `[前端入口] id=${appId} mount=${mountPath} ${req.method} ${req.originalUrl}`,
            'Frontend'
          );
          return devProxy(req, res, next);
        });

        RuntimeUtil.makeLog(
          'info',
          `注册前端开发入口: ${mountPath} -> http://127.0.0.1:${defaultPort}`,
          'Frontend'
        );
      }
    }
  } catch (e) {
    RuntimeUtil.makeLog('warn', `初始化前端开发代理失败: ${e.message}`, 'Frontend');
  }

  runtime.express.use((req, res, next) => {
    if (runtime._checkHeadersSent(res, next)) return;
    directoryIndexMiddleware(runtime, req, res, next);
  });

  runtime.express.use((req, res, next) => staticSecurityMiddleware(runtime, req, res, next));

  const staticOptions = createStaticOptions(runtime);
  const { mountCoreWwwStatic } = await import('#infrastructure/http/mount-core-www.js');
  const mounted = await mountCoreWwwStatic(runtime.express, staticOptions);
  runtime.wwwMountPaths = [...mounted].filter((p) => !String(p).startsWith('/core/'));

  runtime.express.use((req, res, next) => {
    if (runtime._checkHeadersSent(res, next)) return;
    const staticRoot = req.staticRoot || paths.www;
    fsSync.mkdirSync(staticRoot, { recursive: true });
    express.static(staticRoot, staticOptions)(req, res, next);
  });
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function directoryIndexMiddleware(runtime, req, res, next) {
  if (res.headersSent) return next();

  const hasExtension = path.extname(req.path);
  if (hasExtension || req.path.endsWith('/')) {
    return next();
  }

  const staticRoot = req.staticRoot || paths.www;
  const dirPath = path.join(staticRoot, req.path);

  try {
    const stat = fsSync.statSync(dirPath);
    if (stat.isDirectory()) {
      const indexFiles = runtimeConfig.server.static.index || ['index.html', 'index.htm'];
      for (const indexFile of indexFiles) {
        const indexPath = path.join(dirPath, indexFile);
        try {
          if (fsSync.statSync(indexPath).isFile()) {
            const redirectUrl = `${req.path}/`;
            RuntimeUtil.makeLog('debug', `目录重定向：${req.path} → ${redirectUrl}`, '服务器');
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

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function setStaticHeaders(runtime, res, filePath) {
  if (runtime._checkHeadersSent(res)) return;

  runtime.httpBusiness.handleCDN({ headers: {} }, res, filePath);

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
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

  const cacheConfig = runtimeConfig.server.static.cache || {};
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

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function staticSecurityMiddleware(runtime, req, res, next) {
  if (runtime._checkHeadersSent(res, next)) return;

  const normalizedPath = path.posix.normalize(req.path);

  if (normalizedPath.includes('..')) {
    return res.status(403).json({ error: '禁止访问' });
  }

  if (isHiddenStaticPath(runtime, normalizedPath)) {
    return res.status(404).json({ error: '未找到' });
  }

  next();
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function isHiddenStaticPath(runtime, normalizedPath) {
  if (!normalizedPath) return false;
  if (!runtime._compiledHiddenFileMatchers) {
    const raw = runtimeConfig.server?.security?.hiddenFiles;
    const patterns = (Array.isArray(raw) && raw.length)
      ? raw
      : ['^\\..*', '/\\.', 'node_modules', '\\.git'];

    const compiled = [];
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

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function handleFavicon(runtime, req, res) {
  if (runtime._checkHeadersSent(res)) return;

  const staticRoot = req.staticRoot || paths.www;
  const faviconPath = path.join(staticRoot, 'favicon.ico');

  try {
    if (fsSync.statSync(faviconPath).isFile()) {
      if (!res.headersSent) {
        res.set({
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

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function handleRobotsTxt(runtime, req, res) {
  if (runtime._checkHeadersSent(res)) return;

  const robotsCfg = runtimeConfig.server?.robots || {};
  if (robotsCfg?.enabled === false) {
    if (!res.headersSent) res.status(404).end();
    return;
  }

  const staticRoot = req.staticRoot || paths.www;
  const robotsPath = path.join(staticRoot, 'robots.txt');

  try {
    if (fsSync.statSync(robotsPath).isFile()) {
      if (!res.headersSent) {
        res.set({
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

  const contentOverride = typeof robotsCfg?.content === 'string' ? robotsCfg.content.trim() : '';
  /** 控制台与 Core www 调试挂载：始终禁止收录（配置漏写也会并入） */
  const consoleDisallow = ['/xrk', '/xrk/', '/core/'];
  const configuredDisallow = Array.isArray(robotsCfg?.disallow) && robotsCfg.disallow.length
    ? robotsCfg.disallow
    : ['/api/', '/config/', '/data/', '/lib/', '/plugins/', '/trash/'];
  const disallow = [...new Set([...configuredDisallow.map(String), ...consoleDisallow])];
  const allow = Array.isArray(robotsCfg?.allow)
    ? robotsCfg.allow.map(String).filter((p) => p && p !== '/')
    : [];
  const sitemapPath = (robotsCfg?.sitemapPath && String(robotsCfg.sitemapPath).trim()) || '/sitemap.xml';
  const autoSitemap = robotsCfg?.autoSitemap !== false;

  const sitemapUrl = `${runtime.getServerUrl().replace(/\/$/, '')}${sitemapPath.startsWith('/') ? sitemapPath : `/${sitemapPath}`}`;

  let defaultRobots = contentOverride || [
    'User-agent: *',
    ...disallow.map((p) => `Disallow: ${p}`),
    ...allow.map((p) => `Allow: ${p}`),
    '',
  ].join('\n');

  // 自定义 content 时仍确保控制台路径被 Disallow（已写则不重复）
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
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(defaultRobots);
  }
}
