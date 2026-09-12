/**
 * AgentRuntime WebSocket 连接 / 心跳 / 统计辅助
 * 由 AgentRuntime 类方法薄包装委托，不改变对外行为。
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import RuntimeUtil from '#utils/runtime-util.js'
import runtimeConfig from '#infrastructure/config/config.js'
import { normalizeError } from '#utils/normalize-error.js'
import type {
  RuntimeHttpRequest,
  RuntimeWsHost,
  WsConnectionLike,
  WsHandlerEntry
} from '#infrastructure/http/runtime-host-types.js'

export type { RuntimeWsHost, WsConnectionLike, WsHandlerEntry }

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

type RuntimeLike = RuntimeWsHost

export function getWsHandlersForPath(runtime: RuntimeLike, wsPath: string) {
  const rawHandlers = runtime.wsf?.[wsPath]
  if (!Array.isArray(rawHandlers)) return []
  return rawHandlers.filter(Boolean)
}

export function isWsPathSkipAuth(runtime: RuntimeLike, wsPath: string) {
  const handlers = getWsHandlersForPath(runtime, wsPath)
  return handlers.some((entry) => {
    if (!entry || typeof entry === 'function') return false
    return entry.skipAuth === true
  })
}

export function shouldRequireWsApiAuth(runtime: RuntimeLike, wsPath: string) {
  const apiKeyEnabled = rec(rec(rec(runtimeConfig.server).auth).apiKey).enabled !== false
  if (!apiKeyEnabled) return false
  if (isWsPathSkipAuth(runtime, wsPath)) return false
  return true
}

export function startWebSocketHeartbeat(runtime: RuntimeLike) {
  if (runtime._wsHeartbeatInterval) return

  const wsCfg = rec(rec(runtimeConfig.server).websocket)
  const interval = Number(wsCfg.heartbeatInterval) || 30000
  const timeout = Number(wsCfg.heartbeatTimeout) || 60000

  runtime._wsHeartbeatInterval = setInterval(() => {
    const now = Date.now()
    const deadConnections: string[] = []

    for (const [id, conn] of runtime._wsConnections.entries()) {
      if (now - (conn.lastPing || 0) > timeout) {
        deadConnections.push(id)
        try {
          conn.terminate?.()
        } catch {
          // 忽略已关闭的连接
        }
        continue
      }

      if (conn.readyState === conn.OPEN) {
        try {
          conn.isAlive = false
          conn.ping?.()
        } catch {
          deadConnections.push(id)
        }
      } else {
        deadConnections.push(id)
      }
    }

    for (const id of deadConnections) {
      runtime._wsConnections.delete(id)
    }

    if (deadConnections.length > 0) {
      RuntimeUtil.makeLog('debug', `清理 ${deadConnections.length} 个WebSocket死连接`, '服务器')
    }
  }, interval)
}

export function stopWebSocketHeartbeat(runtime: RuntimeLike) {
  if (runtime._wsHeartbeatInterval) {
    clearInterval(runtime._wsHeartbeatInterval)
    runtime._wsHeartbeatInterval = null
  }
}

export function getWebSocketStats(runtime: RuntimeLike) {
  const stats: {
    total: number
    byPath: Record<string, number>
    oldest: { id: string; path: string; connectedAt: number } | null
    newest: { id: string; path: string; connectedAt: number } | null
  } = {
    total: runtime._wsConnections.size,
    byPath: {},
    oldest: null,
    newest: null
  }

  let oldestTime = Infinity
  let newestTime = 0

  for (const [id, conn] of runtime._wsConnections.entries()) {
    const path = conn.path || 'unknown'
    stats.byPath[path] = (stats.byPath[path] || 0) + 1

    if (conn.connectedAt) {
      if (conn.connectedAt < oldestTime) {
        oldestTime = conn.connectedAt
        stats.oldest = { id, path, connectedAt: conn.connectedAt }
      }
      if (conn.connectedAt > newestTime) {
        newestTime = conn.connectedAt
        stats.newest = { id, path, connectedAt: conn.connectedAt }
      }
    }
  }

  return stats
}

export function wsConnect(
  runtime: RuntimeLike,
  req: RuntimeHttpRequest,
  socket: Duplex,
  head: Buffer
) {
  const remoteAddress = String(req.socket?.remoteAddress || '')
  const remotePort = req.socket?.remotePort
  const localAddress = req.socket?.localAddress
  const localPort = req.socket?.localPort
  const headers = req.headers || {}
  const host = String(headers.host || `${localAddress}:${localPort}`)
  const secKey = String(headers['sec-websocket-key'] || '')
  const url = String(req.url || '')

  req.rid = `${remoteAddress}:${remotePort}-${secKey}`
  req.sid = `ws://${host}${url}`
  req.query = Object.fromEntries(new URL(String(req.sid)).searchParams.entries())

  const pathStr = url.split('?')[0]
  const wsPath = pathStr.startsWith('/') ? pathStr.slice(1) : pathStr

  if (!wsPath || !(wsPath in runtime.wsf)) {
    RuntimeUtil.makeLog(
      'warn',
      `WebSocket路径未找到: ${url} (解析为: ${wsPath}), 可用路径: ${Object.keys(runtime.wsf).join(', ')}`,
      '服务器'
    )
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    return socket.destroy()
  }

  if (
    shouldRequireWsApiAuth(runtime, wsPath) &&
    !runtime.checkApiAuthorization(req, {
      forceAuth:
        wsPath === 'OneBotv11' &&
        rec(rec(rec(runtimeConfig.server).auth).onebot).requireLoopbackAuth === true
    })
  ) {
    RuntimeUtil.makeLog(
      'warn',
      `WebSocket 鉴权失败：${url} ip=${remoteAddress}`,
      '服务器'
    )
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    } catch {
      /* ignore */
    }
    return socket.destroy()
  }

  RuntimeUtil.makeLog('debug', `WebSocket路径匹配: ${url} -> ${wsPath}`, '服务器')

  runtime.wss.handleUpgrade(req as unknown as IncomingMessage, socket, head, (conn: WsConnectionLike) => {
    const connectionId = `${Date.now()}-${RuntimeUtil.shortId()}`
    conn.id = connectionId
    conn.path = wsPath
    conn.remoteAddress = remoteAddress
    conn.connectedAt = Date.now()
    conn.lastPing = Date.now()
    conn.isAlive = true

    runtime._wsConnections.set(connectionId, conn)

    RuntimeUtil.makeLog('debug', `WebSocket连接建立：${url} [${connectionId}]`, '服务器')

    const onFn = conn.on
    const on = typeof onFn === 'function' ? onFn.bind(conn) : undefined
    if (typeof on === 'function') {
      on('pong', () => {
        conn.isAlive = true
        conn.lastPing = Date.now()
      })

      on('error', (...args: unknown[]) => {
        const errorMsg = normalizeError(args[0]).message
        RuntimeUtil.makeLog('error', `WebSocket错误 [${connectionId}]: ${errorMsg}`, '服务器')
        runtime._wsConnections.delete(connectionId)
      })

      on('close', (...args: unknown[]) => {
        const code = Number(args[0])
        RuntimeUtil.makeLog(
          'debug',
          `WebSocket断开：${url} [${connectionId}] 代码: ${code}`,
          '服务器'
        )
        runtime._wsConnections.delete(connectionId)
      })

      on('message', (...args: unknown[]) => {
        try {
          conn.lastPing = Date.now()
          const msg = args[0]
          const logMsg =
            Buffer.isBuffer(msg) && msg.length > 1024
              ? `[二进制消息，长度：${msg.length}]`
              : RuntimeUtil.String(msg)
          RuntimeUtil.makeLog('trace', `WS消息 [${connectionId}]: ${logMsg}`, '服务器')
        } catch (err) {
          const errorMsg = normalizeError(err).message
          RuntimeUtil.makeLog(
            'error',
            `WebSocket消息处理错误 [${connectionId}]: ${errorMsg}`,
            '服务器'
          )
        }
      })
    }

    conn.sendMsg = (msg: unknown, options: Record<string, unknown> = {}) => {
      try {
        if (conn.readyState !== conn.OPEN) {
          RuntimeUtil.makeLog('warn', `WebSocket未就绪，无法发送 [${connectionId}]`, '服务器')
          return false
        }

        let payload = msg
        if (!Buffer.isBuffer(payload)) {
          payload = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))
        }

        const logMsg =
          (payload as Buffer).length > 1024
            ? `[二进制消息，长度：${(payload as Buffer).length}]`
            : RuntimeUtil.String(payload)
        RuntimeUtil.makeLog('trace', `WS发送 [${connectionId}]: ${logMsg}`, '服务器')

        return typeof conn.send === 'function' ? conn.send(payload, options) : false
      } catch (err) {
        const errorMsg = normalizeError(err).message
        RuntimeUtil.makeLog('error', `WebSocket发送错误 [${connectionId}]: ${errorMsg}`, '服务器')
        runtime._wsConnections.delete(connectionId)
        return false
      }
    }

    startWebSocketHeartbeat(runtime)

    try {
      const handlers = getWsHandlersForPath(runtime, wsPath)
      for (const entry of handlers) {
        const fn = typeof entry === 'function' ? entry : entry.handler
        if (typeof fn === 'function') {
          fn(conn, req, socket, head)
        }
      }
    } catch (err) {
          const errorMsg = normalizeError(err).message
      RuntimeUtil.makeLog(
        'error',
        `WebSocket处理器错误 [${connectionId}]: ${errorMsg}`,
        '服务器'
      )
    }
  })
}
