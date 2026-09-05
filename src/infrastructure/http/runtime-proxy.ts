/**
 * AgentRuntime 反向代理辅助（初始化 / SSL / 域名证书 / 启动）
 * 由 AgentRuntime 类方法薄包装委托，不改变对外行为。
 */
// @ts-expect-error express 无 @types/express（与仓库约定一致）
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import chalk from 'chalk';
import { createProxyMiddleware } from 'http-proxy-middleware';
import RuntimeUtil from '#utils/runtime-util.js';
import runtimeConfig from '#infrastructure/config/config.js';
import { errorHandler, ErrorCodes } from '#utils/error-handler.js';
import { loadSSLCertificate } from '#infrastructure/http/runtime-listen.js';
import { getProxyConfig, getServerHost } from '#infrastructure/http/runtime-net.js';

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {object} req
 */
export function extractClientIP(runtime: any, req: any) {
  const cdnInfo = runtime.httpBusiness.cdnManager.isCDNRequest(req);
  if (cdnInfo?.ip) {
    return cdnInfo.ip;
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  if (req.headers['x-real-ip']) {
    return req.headers['x-real-ip'];
  }

  return req.ip || req.connection?.remoteAddress || '0.0.0.0';
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function initProxyApp(runtime: any) {
  const proxyConfig = getProxyConfig();
  if (!proxyConfig?.enabled) return;

  runtime.proxyApp = express();

  await loadDomainCertificates(runtime);

  runtime.proxyApp.use(async (req: any, res: any, next: any) => {
    const hostname = req.hostname || req.headers.host?.split(':')[0];

    if (!hostname) {
      return res.status(400).send('错误请求：缺少Host头');
    }

    const domainConfig = findDomainConfig(runtime, hostname);

    if (!domainConfig) {
      return res.status(404).send(`域名 ${hostname} 未配置`);
    }

    if (domainConfig.rewritePath) {
      const { from, to } = domainConfig.rewritePath;
      if (from && req.path.startsWith(from)) {
        const newPath = req.path.replace(from, to || '');
        req.url = newPath + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
        RuntimeUtil.makeLog('debug', `路径重写：${req.path} → ${newPath}`, '代理');
      }
    }

    if (domainConfig.target) {
      const clientIP = extractClientIP(runtime, req);

      const upstream = runtime.httpBusiness.selectProxyUpstream(
        hostname,
        domainConfig.loadBalance || 'round-robin',
        clientIP
      );

      const targetUrl = upstream?.url || domainConfig.target;
      const configWithTarget = { ...domainConfig, target: targetUrl };

      return handleProxyRequest(runtime, req, res, next, configWithTarget, hostname, targetUrl);
    }

    const targetPort = runtime.actualPort;
    const targetUrl = `http://127.0.0.1:${targetPort}`;

    const defaultConfig = {
      ...domainConfig,
      target: targetUrl,
      domain: hostname
    };

    return handleProxyRequest(runtime, req, res, next, defaultConfig, hostname, targetUrl);
  });

  const perfCfg = runtimeConfig.server?.performance || {};
  const keepAliveCfg = perfCfg?.keepAlive || {};
  const httpServerCfg = perfCfg?.httpServer || {};

  const keepAliveEnabled = keepAliveCfg?.enabled !== false;
  const keepAliveInitialDelay = Number(keepAliveCfg?.initialDelay) || 1000;
  const socketTimeout = Number(httpServerCfg?.socketTimeout) || Number(keepAliveCfg?.timeout) || 120000;
  const serverTimeout = Number(httpServerCfg?.serverTimeout) || Number(keepAliveCfg?.timeout) || 120000;
  const headersTimeout = Number(httpServerCfg?.headersTimeout) || 60000;
  const maxHeadersCount = Number(httpServerCfg?.maxHeadersCount) || 2000;

  const proxyServerOptions = {
    keepAlive: keepAliveEnabled,
    keepAliveInitialDelay,
    maxHeadersCount,
    timeout: serverTimeout,
    headersTimeout
  };

  runtime.proxyServer = http.createServer(proxyServerOptions, runtime.proxyApp);
  runtime.proxyServer.on("error", (err: any) => {
    RuntimeUtil.makeLog("error", `HTTP代理服务器错误：${err.message}`, '代理');
  });
  runtime.proxyServer.on("connection", (socket: any) => {
    socket.setTimeout(socketTimeout);
    socket.setKeepAlive(keepAliveEnabled, keepAliveInitialDelay);
  });

  if (runtime.sslContexts.size > 0) {
    await createHttpsProxyServer(runtime);
  }
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function loadDomainCertificates(runtime: any) {
  const proxyConfig = getProxyConfig();
  if (!proxyConfig?.domains) return;

  for (const domainConfig of proxyConfig.domains) {
    if (!domainConfig.ssl?.enabled || !domainConfig.ssl?.certificate) continue;

    const cert = domainConfig.ssl.certificate;

    try {
      const httpsOptions = await loadSSLCertificate(cert, `代理域名 ${domainConfig.domain}`);

      const httpsConfig = runtimeConfig.server.https || {};
      const tlsConfig = httpsConfig.tls || {};

      const context = tls.createSecureContext({
        ...httpsOptions,
        minVersion: tlsConfig.minVersion || 'TLSv1.2',
        honorCipherOrder: true,
        sessionIdContext: `xrk-agt-proxy-${domainConfig.domain}`
      });

      runtime.sslContexts.set(domainConfig.domain, context);
      runtime.domainConfigs.set(domainConfig.domain, domainConfig);
      RuntimeUtil.makeLog("info", `✓ 加载SSL证书：${domainConfig.domain}`, '代理');
    } catch (error: any) {
      RuntimeUtil.makeLog("error", `加载域名 ${domainConfig.domain} 的SSL证书失败：${error.message}`, '代理');
    }
  }
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function createHttpsProxyServer(runtime: any) {
  if (runtime.sslContexts.size === 0) {
    RuntimeUtil.makeLog("warn", "没有可用的SSL证书，跳过HTTPS代理服务器创建", '代理');
    return;
  }

  const [firstDomain] = runtime.sslContexts.keys();
  const domainConfig = runtime.domainConfigs.get(firstDomain);

  if (!domainConfig?.ssl?.certificate) {
    RuntimeUtil.makeLog("error", "没有可用的SSL证书", '代理');
    return;
  }

  const cert = domainConfig.ssl.certificate;
  const httpsConfig = runtimeConfig.server.https || {};
  const tlsConfig = httpsConfig.tls || {};

  let httpsOptions;
  try {
    httpsOptions = await loadSSLCertificate(cert, `HTTPS代理服务器（默认证书）`);
  } catch (error: any) {
    RuntimeUtil.makeLog("error", `加载默认SSL证书失败：${error.message}`, '代理');
    return;
  }

  httpsOptions.minVersion = tlsConfig.minVersion || 'TLSv1.2';
  httpsOptions.honorCipherOrder = true;
  const keepAliveCfg = runtimeConfig.server?.performance?.keepAlive || {};
  const keepAliveEnabled = keepAliveCfg?.enabled !== false;
  const keepAliveInitialDelay = Number(keepAliveCfg?.initialDelay) || 1000;
  httpsOptions.keepAlive = keepAliveEnabled;
  httpsOptions.keepAliveInitialDelay = keepAliveInitialDelay;

  httpsOptions.SNICallback = (servername: any, cb: any) => {
    const context = runtime.sslContexts.get(servername) || findWildcardContext(runtime, servername);
    if (context) {
      cb(null, context);
    } else {
      RuntimeUtil.makeLog('debug', `未找到域名 ${servername} 的SSL证书，使用默认证书`, '代理');
      cb(null, null);
    }
  };

  if (tlsConfig.http2 === true) {
    const http2 = await import('http2');
    const { createSecureServer } = http2;

    httpsOptions.allowHTTP1 = true;
    runtime.proxyHttpsServer = createSecureServer(httpsOptions, runtime.proxyApp);
    runtime.proxyHttpsServer.on("error", (err: any) => {
      RuntimeUtil.makeLog("error", `HTTPS代理服务器错误：${err.message}`, '代理');
    });
    RuntimeUtil.makeLog("info", "✓ HTTPS代理服务器已启动（HTTP/2支持）", '代理');
    return;
  }

  runtime.proxyHttpsServer = https.createServer(httpsOptions, runtime.proxyApp);
  runtime.proxyHttpsServer.on("error", (err: any) => {
    RuntimeUtil.makeLog("error", `HTTPS代理服务器错误：${err.message}`, '代理');
  });
}

/**
 * @param {object} domainConfig
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function createProxyOptions(runtime: any, domainConfig: any) {
  return {
    target: domainConfig.target,
    changeOrigin: true,
    ws: domainConfig.ws !== false,
    preserveHostHeader: domainConfig.preserveHostHeader === true,
    timeout: domainConfig.timeout || 30000,
    proxyTimeout: domainConfig.timeout || 30000,
    secure: false,
    logLevel: 'warn',

    onProxyReq: (proxyReq: any, req: any) => {
      handleProxyRequestStart(runtime, proxyReq, req, domainConfig);
    },

    onProxyRes: (proxyRes: any, req: any, res: any) => {
      handleProxyResponse(runtime, proxyRes, req, res, domainConfig);
    },

    onError: (err: any, req: any, res: any) => {
      handleProxyError(runtime, err, req, res, domainConfig);
    },

    ...(domainConfig.pathRewrite && typeof domainConfig.pathRewrite === 'object'
      ? { pathRewrite: domainConfig.pathRewrite }
      : {})
  };
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {object} domainConfig
 */
export function createDomainProxyMiddleware(runtime: any, domainConfig: any) {
  const proxyOptions = createProxyOptions(runtime, domainConfig);
  return createProxyMiddleware(proxyOptions);
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {object} req
 * @param {object} res
 * @param {Function} next
 * @param {object} domainConfig
 * @param {string} hostname
 * @param {string} targetUrl
 */
export function handleProxyRequest(runtime: any, req: any, res: any, next: any, domainConfig: any, hostname: any, targetUrl: any) {
  manageProxyConnection(runtime, hostname, targetUrl, 'increment');

  res.on('finish', () => {
    manageProxyConnection(runtime, hostname, targetUrl, 'decrement');
  });

  const middleware = getOrCreateProxyMiddleware(runtime, domainConfig, targetUrl);
  return middleware(req, res, next);
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {object} domainConfig
 * @param {string} targetUrl
 */
export function getOrCreateProxyMiddleware(runtime: any, domainConfig: any, targetUrl: any) {
  const cacheKey = `${domainConfig.domain}-${targetUrl}`;
  let middleware = runtime.proxyMiddlewares.get(cacheKey);

  if (!middleware) {
    const configWithTarget = { ...domainConfig, target: targetUrl };
    middleware = createDomainProxyMiddleware(runtime, configWithTarget);
    runtime.proxyMiddlewares.set(cacheKey, middleware);
  }

  return middleware;
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {string} domain
 * @param {string} targetUrl
 * @param {string} operation
 */
export function manageProxyConnection(runtime: any, domain: any, targetUrl: any, operation: any) {
  if (operation === 'increment') {
    runtime.httpBusiness.proxyManager.incrementConnections(domain, targetUrl);
  } else if (operation === 'decrement') {
    runtime.httpBusiness.proxyManager.decrementConnections(domain, targetUrl);
  }
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {object} proxyReq
 * @param {object} req
 * @param {object} domainConfig
 */
export function handleProxyRequestStart(runtime: any, proxyReq: any, req: any, domainConfig: any) {
  req._proxyStartTime = Date.now();

  if (domainConfig.headers?.request) {
    for (const [key, value] of Object.entries(domainConfig.headers.request)) {
      proxyReq.setHeader(key, value);
    }
  }

  const clientIP = extractClientIP(runtime, req);
  proxyReq.setHeader('X-Forwarded-For', clientIP);
  proxyReq.setHeader('X-Real-IP', clientIP);

  if (req.requestId) {
    proxyReq.setHeader('X-Request-Id', req.requestId);
  }
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {object} proxyRes
 * @param {object} req
 * @param {object} res
 * @param {object} domainConfig
 */
export function handleProxyResponse(runtime: any, proxyRes: any, req: any, res: any, domainConfig: any) {
  const startTime = req._proxyStartTime || Date.now();
  const responseTime = Date.now() - startTime;

  if (domainConfig.headers?.response) {
    for (const [key, value] of Object.entries(domainConfig.headers.response)) {
      res.setHeader(key, value);
    }
  }

  res.setHeader('X-Response-Time', `${responseTime}ms`);

  res.on('finish', () => {
    const targetUrl = domainConfig.target;
    if (targetUrl) {
      manageProxyConnection(runtime, domainConfig.domain, targetUrl, 'decrement');
      runtime.httpBusiness.proxyManager.markUpstreamSuccess(domainConfig.domain, targetUrl, responseTime);
    }
  });
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {Error} err
 * @param {object} req
 * @param {object} res
 * @param {object} domainConfig
 */
export function handleProxyError(runtime: any, err: any, req: any, res: any, domainConfig: any) {
  const hostname = domainConfig.domain || req.hostname || 'unknown';
  const targetUrl = domainConfig.target || 'unknown';

  errorHandler.handle(
    err,
    { context: 'proxy', hostname, code: ErrorCodes.NETWORK_ERROR },
    true
  );

  RuntimeUtil.makeLog('error', `代理错误 [${hostname}]: ${err.message}`, '代理');

  if (domainConfig.target) {
    runtime.httpBusiness.markProxyFailure(domainConfig.domain, targetUrl);
    manageProxyConnection(runtime, domainConfig.domain, targetUrl, 'decrement');
  }

  if (!res.headersSent) {
    res.status(502).json({
      error: '网关错误',
      message: '代理服务器错误',
      domain: domainConfig.domain || hostname,
      target: targetUrl,
      requestId: req.requestId || null
    });
  }
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {string} hostname
 */
export function findDomainConfig(runtime: any, hostname: any) {
  if (runtime.domainConfigs.has(hostname)) {
    return runtime.domainConfigs.get(hostname);
  }

  for (const [domain, config] of runtime.domainConfigs) {
    if (domain.startsWith('*.')) {
      const baseDomain = domain.substring(2);
      if (hostname === baseDomain || hostname.endsWith('.' + baseDomain)) {
        const subdomain = hostname === baseDomain ? '' :
          hostname.substring(0, hostname.length - baseDomain.length - 1);
        const configCopy = { ...config, subdomain };

        if (config.rewritePath?.to?.includes('${subdomain}')) {
          configCopy.rewritePath = {
            ...config.rewritePath,
            to: config.rewritePath.to.replace('${subdomain}', subdomain)
          };
        }

        return configCopy;
      }
    }
  }

  return null;
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {string} servername
 */
export function findWildcardContext(runtime: any, servername: any) {
  for (const [domain, context] of runtime.sslContexts) {
    if (domain.startsWith('*.')) {
      const baseDomain = domain.substring(2);
      if (servername === baseDomain || servername.endsWith('.' + baseDomain)) {
        return context;
      }
    }
  }
  return null;
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function startProxyServers(runtime: any) {
  const proxyConfig = getProxyConfig();
  if (!proxyConfig?.enabled) return;

  const httpPort = proxyConfig.httpPort || 80;
  const host = getServerHost();

  runtime.proxyServer.listen(httpPort, host);
  await RuntimeUtil.promiseEvent(runtime.proxyServer, "listening").catch(() => { });

  RuntimeUtil.makeLog('info', `✓ HTTP代理服务器监听在 ${host}:${httpPort}`, '代理');

  if (runtime.proxyHttpsServer) {
    const httpsPort = proxyConfig.httpsPort || 443;
    runtime.proxyHttpsServer.listen(httpsPort, host);
    await RuntimeUtil.promiseEvent(runtime.proxyHttpsServer, "listening").catch(() => { });

    RuntimeUtil.makeLog('info', `✓ HTTPS代理服务器监听在 ${host}:${httpsPort}`, '代理');
  }

  await displayProxyInfo(runtime);
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function displayProxyInfo(runtime: any) {
  console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('║') + chalk.yellow.bold('                  反向代理服务器配置信息                    ') + chalk.cyan('║'));
  console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));

  console.log(chalk.cyan('▶ 代理域名：'));

  const proxyConfig = getProxyConfig();
  const domains = proxyConfig?.domains || [];

  for (const domainConfig of domains) {
    const protocol = domainConfig.ssl?.enabled ? 'https' : 'http';
    const port = protocol === 'https' ?
      (proxyConfig.httpsPort || 443) :
      (proxyConfig.httpPort || 80);
    const displayPort = (port === 80 && protocol === 'http') ||
      (port === 443 && protocol === 'https') ? '' : `:${port}`;

    console.log(chalk.yellow(`    ${domainConfig.domain}：`));
    console.log(`      ${chalk.cyan('•')} 访问地址：${chalk.white(`${protocol}://${domainConfig.domain}${displayPort}`)}`);

    if (domainConfig.target) {
      console.log(`      ${chalk.cyan('•')} 代理目标：${chalk.gray(domainConfig.target)}`);
    } else {
      console.log(`      ${chalk.cyan('•')} 代理目标：${chalk.gray(`本地服务端口 ${runtime.actualPort}`)}`);
    }

    if (domainConfig.staticRoot) {
      console.log(`      ${chalk.cyan('•')} 静态目录：${chalk.gray(domainConfig.staticRoot)}`);
    }

    if (domainConfig.rewritePath) {
      console.log(`      ${chalk.cyan('•')} 路径重写：${chalk.gray(`${domainConfig.rewritePath.from} → ${domainConfig.rewritePath.to}`)}`);
    }
  }

  console.log(chalk.yellow('\n▶ 本地服务：'));
  console.log(`    ${chalk.cyan('•')} HTTP：${chalk.white(`http://localhost:${runtime.actualPort}`)}`);
  if (runtime.actualHttpsPort) {
    console.log(`    ${chalk.cyan('•')} HTTPS：${chalk.white(`https://localhost:${runtime.actualHttpsPort}`)}`);
  }
  console.log('\n');
}
