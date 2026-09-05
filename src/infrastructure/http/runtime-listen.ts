/**
 * AgentRuntime HTTP/HTTPS 监听 / 关闭 / URL 辅助
 * 由 AgentRuntime 类方法薄包装委托，不改变对外行为。
 */
import fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import https from 'node:https'
import RuntimeUtil from '#utils/runtime-util.js'
import runtimeConfig from '#infrastructure/config/config.js'
import { stopAllLoaderWatchers } from '#utils/loader-shutdown.js'
import FrontendLauncher from '#infrastructure/frontend/launcher.js'
import {
  getConfiguredServerUrl,
  getProxyConfig,
  getServerHost,
  isHttpsEnabled
} from '#infrastructure/http/runtime-net.js'

type RuntimeLike = Record<string, any>

export async function loadSSLCertificate(
  certConfig: { key?: string; cert?: string; ca?: string },
  context = '服务器'
) {
  if (!certConfig?.key || !certConfig?.cert) {
    throw new Error(`${context}：证书配置不完整，需要key和cert`)
  }

  try {
    const keyStat = fsSync.statSync(certConfig.key)
    if (!keyStat.isFile()) {
      throw new Error(`${context}：密钥路径不是文件：${certConfig.key}`)
    }
  } catch (error: any) {
    throw new Error(
      `${context}：密钥文件不存在或无法访问：${certConfig.key} - ${error.message}`
    )
  }

  try {
    const certStat = fsSync.statSync(certConfig.cert)
    if (!certStat.isFile()) {
      throw new Error(`${context}：证书路径不是文件：${certConfig.cert}`)
    }
  } catch (error: any) {
    throw new Error(
      `${context}：证书文件不存在或无法访问：${certConfig.cert} - ${error.message}`
    )
  }

  const httpsOptions: Record<string, any> = {
    key: await fs.readFile(certConfig.key),
    cert: await fs.readFile(certConfig.cert),
    allowHTTP1: true
  }

  if (certConfig.ca) {
    try {
      if (fsSync.statSync(certConfig.ca).isFile()) {
        httpsOptions.ca = await fs.readFile(certConfig.ca)
        RuntimeUtil.makeLog('debug', `${context}：已加载CA证书：${certConfig.ca}`, context)
      }
    } catch {
      RuntimeUtil.makeLog(
        'debug',
        `${context}：CA证书文件不存在或无法访问：${certConfig.ca}，跳过`,
        context
      )
    }
  }

  return httpsOptions
}

export async function serverEADDRINUSE(runtime: RuntimeLike, _err: Error, isHttps: boolean) {
  const serverType = isHttps ? 'HTTPS' : 'HTTP'
  const port = isHttps ? runtime.httpsPort : runtime.httpPort

  RuntimeUtil.makeLog('error', `${serverType}端口 ${port} 已被占用`, '服务器')

  const retryKey = isHttps ? 'https_retry_count' : 'http_retry_count'
  runtime[retryKey] = (runtime[retryKey] || 0) + 1

  if (runtime[retryKey] >= 10) {
    RuntimeUtil.makeLog(
      'error',
      `${serverType}端口 ${port} 持续被占用，请检查是否有残留进程后重试`,
      '服务器'
    )
    process.exit(0)
    return
  }

  await RuntimeUtil.sleep(runtime[retryKey] * 1000)

  const server = isHttps ? runtime.httpsServer : runtime.server
  const host = getServerHost()

  if (server) {
    server.listen(port, host)
  }
}

export async function serverLoad(runtime: RuntimeLike, isHttps: boolean) {
  const server = isHttps ? runtime.httpsServer : runtime.server
  const port = isHttps ? runtime.httpsPort : runtime.httpPort
  const host = getServerHost()

  if (!server) return

  server.listen(port, host)

  await RuntimeUtil.promiseEvent(server, 'listening', isHttps && 'error').catch(() => {})

  const serverInfo = server.address()
  if (!serverInfo) {
    RuntimeUtil.makeLog('error', `${isHttps ? 'HTTPS' : 'HTTP'}服务器启动失败`, '服务器')
    return
  }

  if (isHttps) {
    runtime.httpsPort = serverInfo.port
    runtime.actualHttpsPort = serverInfo.port
  } else {
    runtime.httpPort = serverInfo.port
    runtime.actualPort = serverInfo.port
  }

  const serverType = isHttps ? 'HTTPS' : 'HTTP'

  RuntimeUtil.makeLog('info', `✓ ${serverType}服务器监听在 ${host}:${serverInfo.port}`, '服务器')
}

export async function httpsLoad(runtime: RuntimeLike) {
  const httpsConfig = (runtimeConfig as any).server.https

  if (!httpsConfig.enabled) {
    return
  }

  let httpsOptions: Record<string, any> = {}

  if (httpsConfig?.certificate) {
    httpsOptions = await loadSSLCertificate(httpsConfig.certificate, 'HTTPS服务器')
  }

  const tlsConfig = httpsConfig?.tls || {}

  httpsOptions.minVersion = tlsConfig.minVersion || 'TLSv1.2'
  if (tlsConfig.maxVersion) {
    httpsOptions.maxVersion = tlsConfig.maxVersion
  }

  if (tlsConfig.ciphers) {
    httpsOptions.ciphers = tlsConfig.ciphers
  } else {
    httpsOptions.ciphers = [
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305'
    ].join(':')
  }

  httpsOptions.honorCipherOrder = true

  const keepAliveCfg = (runtimeConfig as any).server?.performance?.keepAlive || {}
  const keepAliveEnabled = keepAliveCfg?.enabled !== false
  const keepAliveInitialDelay = Number(keepAliveCfg?.initialDelay) || 1000
  httpsOptions.keepAlive = keepAliveEnabled
  httpsOptions.keepAliveInitialDelay = keepAliveInitialDelay

  httpsOptions.sessionIdContext = 'xrk-agt-server'

  if (tlsConfig.http2 === true) {
    try {
      const http2 = await import('node:http2')
      const { createSecureServer } = http2

      httpsOptions.allowHTTP1 = true
      runtime.httpsServer = createSecureServer(httpsOptions, runtime.express)
        .on('error', (err: Error) => runtime._handleServerError(err, true))
        .on('upgrade', runtime.wsConnect.bind(runtime))

      RuntimeUtil.makeLog('info', '✓ HTTPS服务器已启动（HTTP/2支持）', '服务器')
    } catch (err: any) {
      RuntimeUtil.makeLog('warn', `HTTP/2不可用，回退到HTTP/1.1: ${err.message}`, '服务器')
      runtime.httpsServer = https
        .createServer(httpsOptions, runtime.express)
        .on('error', (e: Error) => runtime._handleServerError(e, true))
        .on('upgrade', runtime.wsConnect.bind(runtime))
    }
  } else {
    runtime.httpsServer = https
      .createServer(httpsOptions, runtime.express)
      .on('error', (err: Error) => runtime._handleServerError(err, true))
      .on('upgrade', runtime.wsConnect.bind(runtime))
  }

  await serverLoad(runtime, true)

  if (tlsConfig.http2 !== true) {
    RuntimeUtil.makeLog('info', '✓ HTTPS服务器已启动', '服务器')
  }
}

export async function closeServer(runtime: RuntimeLike, options: { fast?: boolean } = {}) {
  RuntimeUtil.makeLog('info', '⏳ 正在关闭服务器...', '服务器')

  try {
    await FrontendLauncher.stopAll()
  } catch {
    /* ignore */
  }

  runtime._stopWebSocketHeartbeat()

  for (const [, conn] of runtime._wsConnections.entries()) {
    try {
      conn.terminate()
    } catch {
      // 忽略已关闭的连接
    }
  }
  runtime._wsConnections.clear()

  const servers = [
    runtime.server,
    runtime.httpsServer,
    runtime.proxyServer,
    runtime.proxyHttpsServer
  ].filter(Boolean)

  if (runtime._trashTimer) {
    clearInterval(runtime._trashTimer)
    runtime._trashTimer = null
  }

  try {
    await stopAllLoaderWatchers()
  } catch {
    /* ignore */
  }

  await Promise.all(servers.map((server: any) => new Promise((resolve) => server.close(resolve))))

  if (!options.fast) {
    await RuntimeUtil.sleep(2000)
  }
  await runtime.redisExit()

  try {
    const logger = (globalThis as any).logger
    if (logger?.shutdown) {
      await logger.shutdown()
    }
  } catch {
    /* ignore */
  }

  RuntimeUtil.makeLog('info', '✓ 服务器已关闭', '服务器')
}

export function getServerUrl(runtime: RuntimeLike) {
  const proxyConfig = getProxyConfig()
  if (runtime.proxyEnabled && Array.isArray(proxyConfig.domains) && proxyConfig.domains[0]) {
    const domain = proxyConfig.domains[0]
    const protocol = domain.ssl?.enabled ? 'https' : 'http'
    return `${protocol}://${domain.domain}`
  }

  const configuredUrl = getConfiguredServerUrl()
  if (configuredUrl) {
    const withScheme = /^https?:\/\//i.test(configuredUrl)
      ? configuredUrl
      : `${isHttpsEnabled() ? 'https' : 'http'}://${configuredUrl.replace(/^\/+/, '')}`
    return new URL(withScheme).toString().replace(/\/+$/, '')
  }

  const protocol = isHttpsEnabled() ? 'https' : 'http'
  const port = protocol === 'https' ? runtime.actualHttpsPort : runtime.actualPort
  const needPort = (protocol === 'http' && port !== 80) || (protocol === 'https' && port !== 443)

  return `${protocol}://127.0.0.1${needPort ? ':' + port : ''}`
}
