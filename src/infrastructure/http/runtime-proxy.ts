/**
 * AgentRuntime 反向代理辅助（初始化 / SSL / 域名证书 / 启动）
 * 由 AgentRuntime 类方法薄包装委托，不改变对外行为。
 */
// @ts-expect-error express 无 @types/express（与仓库约定一致）
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { RequestListener } from 'node:http';
import type { Socket } from 'node:net';
import type { SecureVersion } from 'node:tls';
import chalk from 'chalk';
import { createProxyMiddleware } from 'http-proxy-middleware';
import RuntimeUtil from '#utils/runtime-util.js';
import runtimeConfig from '#infrastructure/config/config.js';
import { errorHandler, ErrorCodes } from '#utils/error-handler.js';
import { normalizeError } from '#utils/normalize-error.js';
import { loadSSLCertificate } from '#infrastructure/http/runtime-listen.js';
import { getProxyConfig, getServerHost } from '#infrastructure/http/runtime-net.js';
import type {
  ProxyDomainConfig,
  RuntimeHttpRequest,
  RuntimeProxyHost,
} from '#infrastructure/http/runtime-host-types.js';

export type { RuntimeProxyHost, ProxyDomainConfig };

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asDomain(v: unknown): ProxyDomainConfig {
  return rec(v) as ProxyDomainConfig;
}

function targetKey(targetUrl: unknown): string {
  return Array.isArray(targetUrl) ? String(targetUrl[0] ?? '') : String(targetUrl ?? '');
}

type ProxyExpressReq = RuntimeHttpRequest & {
  hostname?: string;
  path?: string;
  url?: string;
  requestId?: string;
  _proxyStartTime?: number;
};

type ProxyExpressRes = {
  headersSent?: boolean;
  status: (code: number) => { send: (body: string) => unknown; json: (body: unknown) => unknown };
  send: (body: string) => unknown;
  setHeader: (name: string, value: string) => unknown;
  on: (event: string, cb: () => void) => unknown;
};

type ProxyNext = (err?: unknown) => void;

type ProxyClientReq = {
  setHeader: (name: string, value: string | number | readonly string[]) => unknown;
};

type TlsProxyOptions = Awaited<ReturnType<typeof loadSSLCertificate>> & {
  allowHTTP1?: boolean;
  SNICallback?: (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void;
  minVersion?: SecureVersion;
  honorCipherOrder?: boolean;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
};

type ProxyMw = (req: ProxyExpressReq, res: ProxyExpressRes, next: ProxyNext) => unknown;

/**
 * @param {RuntimeProxyHost} runtime
 * @param {RuntimeHttpRequest} req
 */
export function extractClientIP(runtime: RuntimeProxyHost, req: RuntimeHttpRequest) {
  const cdnInfo = runtime.httpBusiness.cdnManager.isCDNRequest(req);
  if (cdnInfo?.ip) {
    return cdnInfo.ip;
  }

  const forwardedFor = req.headers?.['x-forwarded-for'];
  if (forwardedFor) {
    const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : String(forwardedFor);
    return raw.split(',')[0].trim();
  }

  const realIp = req.headers?.['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? String(realIp[0]) : String(realIp);
  }

  return String((req as { ip?: string; connection?: { remoteAddress?: string } }).ip
    || (req as { connection?: { remoteAddress?: string } }).connection?.remoteAddress
    || '0.0.0.0');
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function initProxyApp(runtime: RuntimeProxyHost) {
  const proxyConfig = getProxyConfig()
  if (!proxyConfig.enabled) return

  const proxyApp = express()
  runtime.proxyApp = proxyApp

  await loadDomainCertificates(runtime)

  proxyApp.use(async (req: ProxyExpressReq, res: ProxyExpressRes, next: ProxyNext) => {
    const hostHeader = req.headers?.host
    const hostStr = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader
    const hostname = req.hostname || (typeof hostStr === 'string' ? hostStr.split(':')[0] : undefined)

    if (!hostname) {
      return res.status(400).send('错误请求：缺少Host头')
    }

    const domainConfig = findDomainConfig(runtime, hostname)

    if (!domainConfig) {
      return res.status(404).send(`域名 ${hostname} 未配置`)
    }

    if (domainConfig.rewritePath) {
      const { from, to } = domainConfig.rewritePath
      const reqPath = req.path || ''
      const reqUrl = req.url || ''
      if (from && reqPath.startsWith(from)) {
        const newPath = reqPath.replace(from, to || '')
        req.url = newPath + (reqUrl.includes('?') ? reqUrl.substring(reqUrl.indexOf('?')) : '')
        RuntimeUtil.makeLog('debug', `路径重写：${reqPath} → ${newPath}`, '代理')
      }
    }

    if (domainConfig.target) {
      const clientIP = extractClientIP(runtime, req)

      const upstream = runtime.httpBusiness.selectProxyUpstream(
        hostname,
        domainConfig.loadBalance || 'round-robin',
        clientIP
      )

      const targetUrl =
        (upstream && typeof upstream === 'object' ? upstream.url : typeof upstream === 'string' ? upstream : undefined) ||
        domainConfig.target
      const configWithTarget = { ...domainConfig, target: targetUrl }

      return handleProxyRequest(runtime, req, res, next, configWithTarget, hostname, targetUrl)
    }

    const targetPort = runtime.actualPort
    const targetUrl = `http://127.0.0.1:${targetPort}`

    const defaultConfig = {
      ...domainConfig,
      target: targetUrl,
      domain: hostname
    }

    return handleProxyRequest(runtime, req, res, next, defaultConfig, hostname, targetUrl)
  })

  const perfCfg = rec(rec(runtimeConfig.server).performance)
  const keepAliveCfg = rec(perfCfg.keepAlive)
  const httpServerCfg = rec(perfCfg.httpServer)

  const keepAliveEnabled = keepAliveCfg.enabled !== false
  const keepAliveInitialDelay = Number(keepAliveCfg.initialDelay) || 1000
  const socketTimeout = Number(httpServerCfg.socketTimeout) || Number(keepAliveCfg.timeout) || 120000
  const serverTimeout = Number(httpServerCfg.serverTimeout) || Number(keepAliveCfg.timeout) || 120000
  const headersTimeout = Number(httpServerCfg.headersTimeout) || 60000
  const maxHeadersCount = Number(httpServerCfg.maxHeadersCount) || 2000

  const proxyServerOptions = {
    keepAlive: keepAliveEnabled,
    keepAliveInitialDelay,
    maxHeadersCount,
    timeout: serverTimeout,
    headersTimeout
  }

  runtime.proxyServer = http.createServer(proxyServerOptions, proxyApp as unknown as RequestListener)
  runtime.proxyServer.on('error', (err: Error) => {
    RuntimeUtil.makeLog('error', `HTTP代理服务器错误：${err.message}`, '代理')
  })
  runtime.proxyServer.on('connection', (socket: Socket) => {
    socket.setTimeout(socketTimeout)
    socket.setKeepAlive(keepAliveEnabled, keepAliveInitialDelay)
  })

  if (runtime.sslContexts.size > 0) {
    await createHttpsProxyServer(runtime);
  }
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function loadDomainCertificates(runtime: RuntimeProxyHost) {
  const proxyConfig = getProxyConfig()
  const domains = Array.isArray(proxyConfig.domains) ? proxyConfig.domains : []
  if (!domains.length) return

  for (const raw of domains) {
    const domainConfig = asDomain(raw)
    if (!domainConfig.ssl?.enabled || !domainConfig.ssl?.certificate) continue

    const cert = domainConfig.ssl.certificate

    try {
      const httpsOptions = await loadSSLCertificate(cert, `代理域名 ${domainConfig.domain}`)

      const tlsConfig = rec(rec(rec(runtimeConfig.server).https).tls)

      const context = tls.createSecureContext({
        ...httpsOptions,
        minVersion: (typeof tlsConfig.minVersion === 'string' ? tlsConfig.minVersion : 'TLSv1.2') as SecureVersion,
        honorCipherOrder: true,
        sessionIdContext: `xrk-agt-proxy-${domainConfig.domain}`
      })

      runtime.sslContexts.set(domainConfig.domain, context)
      runtime.domainConfigs.set(domainConfig.domain, domainConfig)
      RuntimeUtil.makeLog('info', `✓ 加载SSL证书：${domainConfig.domain}`, '代理')
    } catch (error: unknown) {
      RuntimeUtil.makeLog(
        'error',
        `加载域名 ${domainConfig.domain} 的SSL证书失败：${normalizeError(error).message}`,
        '代理'
      )
    }
  }
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function createHttpsProxyServer(runtime: RuntimeProxyHost) {
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

  const cert = domainConfig.ssl.certificate
  const tlsConfig = rec(rec(rec(runtimeConfig.server).https).tls)

  let httpsOptions: TlsProxyOptions
  try {
    httpsOptions = await loadSSLCertificate(cert, `HTTPS代理服务器（默认证书）`)
  } catch (error: unknown) {
    RuntimeUtil.makeLog('error', `加载默认SSL证书失败：${normalizeError(error).message}`, '代理')
    return
  }

  httpsOptions.minVersion = (typeof tlsConfig.minVersion === 'string' ? tlsConfig.minVersion : 'TLSv1.2') as SecureVersion
  httpsOptions.honorCipherOrder = true
  const keepAliveCfg = rec(rec(rec(runtimeConfig.server).performance).keepAlive)
  const keepAliveEnabled = keepAliveCfg.enabled !== false
  const keepAliveInitialDelay = Number(keepAliveCfg.initialDelay) || 1000
  httpsOptions.keepAlive = keepAliveEnabled
  httpsOptions.keepAliveInitialDelay = keepAliveInitialDelay

  httpsOptions.SNICallback = (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
    const context = runtime.sslContexts.get(servername) || findWildcardContext(runtime, servername)
    if (context) {
      cb(null, context as tls.SecureContext)
    } else {
      RuntimeUtil.makeLog('debug', `未找到域名 ${servername} 的SSL证书，使用默认证书`, '代理')
      cb(null)
    }
  }

  if (tlsConfig.http2 === true) {
    const http2 = await import('node:http2')
    const { createSecureServer } = http2

    httpsOptions.allowHTTP1 = true
    runtime.proxyHttpsServer = createSecureServer(
      httpsOptions,
      runtime.proxyApp as never
    ) as unknown as typeof runtime.proxyHttpsServer
    runtime.proxyHttpsServer?.on('error', (err: Error) => {
      RuntimeUtil.makeLog('error', `HTTPS代理服务器错误：${err.message}`, '代理')
    })
    RuntimeUtil.makeLog('info', '✓ HTTPS代理服务器已启动（HTTP/2支持）', '代理')
    return
  }

  runtime.proxyHttpsServer = https.createServer(httpsOptions, runtime.proxyApp as unknown as RequestListener)
  runtime.proxyHttpsServer.on('error', (err: Error) => {
    RuntimeUtil.makeLog('error', `HTTPS代理服务器错误：${err.message}`, '代理')
  })
}

/**
 * @param {object} domainConfig
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function createProxyOptions(runtime: RuntimeProxyHost, domainConfig: ProxyDomainConfig) {
  return {
    target: domainConfig.target,
    changeOrigin: true,
    ws: domainConfig.ws !== false,
    preserveHostHeader: domainConfig.preserveHostHeader === true,
    timeout: domainConfig.timeout || 30000,
    proxyTimeout: domainConfig.timeout || 30000,
    secure: false,
    logLevel: 'warn',

    onProxyReq: (proxyReq: ProxyClientReq, req: ProxyExpressReq) => {
      handleProxyRequestStart(runtime, proxyReq, req, domainConfig);
    },

    onProxyRes: (_proxyRes: unknown, req: ProxyExpressReq, res: ProxyExpressRes) => {
      handleProxyResponse(runtime, _proxyRes, req, res, domainConfig);
    },

    onError: (err: unknown, req: ProxyExpressReq, res: ProxyExpressRes) => {
      handleProxyError(runtime, err, req, res, domainConfig);
    },

    ...(domainConfig.pathRewrite && typeof domainConfig.pathRewrite === 'object'
      ? { pathRewrite: domainConfig.pathRewrite }
      : {})
  };
}

export function createDomainProxyMiddleware(runtime: RuntimeProxyHost, domainConfig: ProxyDomainConfig) {
  const proxyOptions = createProxyOptions(runtime, domainConfig);
  return createProxyMiddleware(proxyOptions as Parameters<typeof createProxyMiddleware>[0]) as ProxyMw;
}

export function handleProxyRequest(
  runtime: RuntimeProxyHost,
  req: ProxyExpressReq,
  res: ProxyExpressRes,
  next: ProxyNext,
  domainConfig: ProxyDomainConfig,
  hostname: string,
  targetUrl: unknown
) {
  manageProxyConnection(runtime, hostname, targetUrl, 'increment');

  res.on('finish', () => {
    manageProxyConnection(runtime, hostname, targetUrl, 'decrement');
  });

  const middleware = getOrCreateProxyMiddleware(runtime, domainConfig, targetUrl);
  return middleware(req, res, next);
}

export function getOrCreateProxyMiddleware(
  runtime: RuntimeProxyHost,
  domainConfig: ProxyDomainConfig,
  targetUrl: unknown
) {
  const cacheKey = `${domainConfig.domain}-${targetKey(targetUrl)}`;
  let middleware = runtime.proxyMiddlewares.get(cacheKey) as ProxyMw | undefined;

  if (!middleware) {
    const configWithTarget = { ...domainConfig, target: targetUrl as ProxyDomainConfig['target'] };
    middleware = createDomainProxyMiddleware(runtime, configWithTarget);
    runtime.proxyMiddlewares.set(cacheKey, middleware);
  }

  return middleware;
}

export function manageProxyConnection(
  runtime: RuntimeProxyHost,
  domain: string,
  targetUrl: unknown,
  operation: string
) {
  const url = targetKey(targetUrl);
  if (operation === 'increment') {
    runtime.httpBusiness.proxyManager.incrementConnections(domain, url);
  } else if (operation === 'decrement') {
    runtime.httpBusiness.proxyManager.decrementConnections(domain, url);
  }
}

export function handleProxyRequestStart(
  runtime: RuntimeProxyHost,
  proxyReq: ProxyClientReq,
  req: ProxyExpressReq,
  domainConfig: ProxyDomainConfig
) {
  req._proxyStartTime = Date.now();

  if (domainConfig.headers?.request) {
    for (const [key, value] of Object.entries(domainConfig.headers.request)) {
      proxyReq.setHeader(key, String(value));
    }
  }

  const clientIP = extractClientIP(runtime, req);
  proxyReq.setHeader('X-Forwarded-For', clientIP);
  proxyReq.setHeader('X-Real-IP', clientIP);

  if (req.requestId) {
    proxyReq.setHeader('X-Request-Id', String(req.requestId));
  }
}

export function handleProxyResponse(
  runtime: RuntimeProxyHost,
  _proxyRes: unknown,
  req: ProxyExpressReq,
  res: ProxyExpressRes,
  domainConfig: ProxyDomainConfig
) {
  const startTime = req._proxyStartTime || Date.now();
  const responseTime = Date.now() - startTime;

  if (domainConfig.headers?.response) {
    for (const [key, value] of Object.entries(domainConfig.headers.response)) {
      res.setHeader(key, String(value));
    }
  }

  res.setHeader('X-Response-Time', `${responseTime}ms`);

  res.on('finish', () => {
    const url = domainConfig.target;
    if (url) {
      manageProxyConnection(runtime, domainConfig.domain, url, 'decrement');
      runtime.httpBusiness.proxyManager.markUpstreamSuccess(domainConfig.domain, targetKey(url), responseTime);
    }
  });
}

export function handleProxyError(
  runtime: RuntimeProxyHost,
  err: unknown,
  req: ProxyExpressReq,
  res: ProxyExpressRes,
  domainConfig: ProxyDomainConfig
) {
  const hostname = domainConfig.domain || req.hostname || 'unknown';
  const targetUrl = domainConfig.target || 'unknown';
  const errObj = normalizeError(err);

  errorHandler.handle(
    errObj,
    { context: 'proxy', hostname, code: ErrorCodes.NETWORK_ERROR },
    true
  );

  RuntimeUtil.makeLog('error', `代理错误 [${hostname}]: ${errObj.message}`, '代理');

  if (domainConfig.target) {
    runtime.httpBusiness.markProxyFailure(domainConfig.domain, targetKey(targetUrl));
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
export function findDomainConfig(runtime: RuntimeProxyHost, hostname: string) {
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
export function findWildcardContext(runtime: RuntimeProxyHost, servername: string) {
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
export async function startProxyServers(runtime: RuntimeProxyHost) {
  const proxyConfig = getProxyConfig();
  if (!proxyConfig.enabled) return;

  const httpPort = Number(proxyConfig.httpPort) || 80;
  const host = getServerHost();

  runtime.proxyServer?.listen(httpPort, host);
  if (runtime.proxyServer) {
    await RuntimeUtil.promiseEvent(runtime.proxyServer, 'listening').catch(() => { });
  }

  RuntimeUtil.makeLog('info', `✓ HTTP代理服务器监听在 ${host}:${httpPort}`, '代理');

  if (runtime.proxyHttpsServer) {
    const httpsPort = Number(proxyConfig.httpsPort) || 443;
    runtime.proxyHttpsServer.listen(httpsPort, host);
    await RuntimeUtil.promiseEvent(runtime.proxyHttpsServer, 'listening').catch(() => { });

    RuntimeUtil.makeLog('info', `✓ HTTPS代理服务器监听在 ${host}:${httpsPort}`, '代理');
  }

  await displayProxyInfo(runtime);
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export async function displayProxyInfo(runtime: RuntimeProxyHost) {
  console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('║') + chalk.yellow.bold('                  反向代理服务器配置信息                    ') + chalk.cyan('║'));
  console.log(chalk.cyan('╚════════════════════════════════════════════════════════════╝\n'));

  console.log(chalk.cyan('▶ 代理域名：'));

  const proxyConfig = getProxyConfig();
  const domains = Array.isArray(proxyConfig.domains) ? proxyConfig.domains.map(asDomain) : [];

  for (const domainConfig of domains) {
    const protocol = domainConfig.ssl?.enabled ? 'https' : 'http';
    const port = protocol === 'https' ?
      (Number(proxyConfig.httpsPort) || 443) :
      (Number(proxyConfig.httpPort) || 80);
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
