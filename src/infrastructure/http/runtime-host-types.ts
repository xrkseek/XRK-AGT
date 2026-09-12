/**
 * AgentRuntime 委托面 Host 接口（鉴权 / WS / 监听 / 代理）。
 * 供 runtime-auth|ws|listen|proxy 使用；薄委托不改变对外行为。
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/** Express 风格请求（委托层不依赖完整 @types/express） */
export type RuntimeHttpRequest = {
  path?: string
  url?: string
  originalUrl?: string
  ip?: string
  hostname?: string
  headers?: Record<string, string | string[] | undefined>
  query?: Record<string, unknown>
  body?: unknown
  socket?: {
    remoteAddress?: string
    remotePort?: number
    localAddress?: string
    localPort?: number
  }
  [key: string]: unknown
}

export type AuthWhitelistRule = {
  type: 'regex' | 'prefix' | 'exact'
  value: RegExp | string
}

export type RuntimeAuthHost = {
  apiKey: string
  _authWhitelistCache: {
    ref: unknown
    rules: AuthWhitelistRule[]
  }
}

export type WsConnectionLike = {
  path?: string
  connectedAt?: number
  lastPing?: number
  isAlive?: boolean
  readyState?: number
  OPEN?: number
  ping?: () => void
  terminate?: () => void
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
  send?: (payload: unknown, options?: Record<string, unknown>) => unknown
  [key: string]: unknown
}

export type WsHandlerEntry =
  | ((conn: WsConnectionLike, req: RuntimeHttpRequest, socket: Duplex, head: Buffer) => void)
  | {
      handler?: (conn: WsConnectionLike, req: RuntimeHttpRequest, socket: Duplex, head: Buffer) => void
      skipAuth?: boolean
    }

export type RuntimeWsHost = {
  wsf: Record<string, WsHandlerEntry | WsHandlerEntry[] | undefined>
  wss: {
    handleUpgrade: (
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      cb: (conn: WsConnectionLike) => void
    ) => void
  }
  _wsConnections: Map<string, WsConnectionLike>
  _wsHeartbeatInterval?: ReturnType<typeof setInterval> | null
  checkApiAuthorization: (
    req: RuntimeHttpRequest,
    options?: Record<string, unknown>
  ) => boolean
}

export type RuntimeListenHost = {
  httpPort: number | null
  httpsPort: number | null
  actualPort: number | null
  actualHttpsPort: number | null
  server: HttpServer | null
  httpsServer: HttpServer | null
  proxyServer: HttpServer | null
  proxyHttpsServer: HttpServer | null
  proxyEnabled: boolean
  express: unknown
  http_retry_count?: number
  https_retry_count?: number
  _wsConnections: Map<string, WsConnectionLike>
  _trashTimer?: ReturnType<typeof setInterval> | null
  _stopWebSocketHeartbeat: () => void
  _handleServerError: (err: Error, isHttps: boolean) => void
  wsConnect: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  redisExit: () => Promise<void> | void
}

export type ProxyDomainConfig = {
  domain: string
  target?: string | string[]
  rewritePath?: { from?: string; to?: string }
  loadBalance?: string
  ssl?: {
    enabled?: boolean
    key?: string
    cert?: string
    ca?: string
    certificate?: { key?: string; cert?: string; ca?: string }
  }
  subdomain?: string
  headers?: {
    request?: Record<string, unknown>
    response?: Record<string, unknown>
  }
  ws?: boolean
  timeout?: number
  pathRewrite?: Record<string, string>
  preserveHostHeader?: boolean
  staticRoot?: string
  [key: string]: unknown
}

export type RuntimeProxyHost = {
  actualPort: number | null
  actualHttpsPort: number | null
  proxyApp: {
    use: (...args: unknown[]) => unknown
    [key: string]: unknown
  } | null
  proxyServer: HttpServer | null
  proxyHttpsServer: HttpServer | null
  proxyMiddlewares: Map<string, unknown>
  domainConfigs: Map<string, ProxyDomainConfig>
  sslContexts: Map<string, unknown>
  httpBusiness: {
    cdnManager: { isCDNRequest: (req: RuntimeHttpRequest) => { ip?: string } | null | undefined }
    selectProxyUpstream: (
      hostname: string,
      strategy: string,
      clientIP: string
    ) => { url?: string } | string | null | undefined
    proxyManager: {
      incrementConnections: (domain: string, targetUrl: string) => void
      decrementConnections: (domain: string, targetUrl: string) => void
      markUpstreamSuccess: (domain: string, targetUrl: string, responseTime: number) => void
    }
    markProxyFailure: (domain: string, targetUrl: string) => void
    [key: string]: unknown
  }
}
