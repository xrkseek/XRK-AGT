import RuntimeUtil from '#utils/runtime-util.js'
import { HttpResponse } from '#utils/http-utils.js'
import { normalizeError } from '#utils/normalize-error.js'
import { ensureSystemCoreAuth } from './auth.js'

export type HttpRouteHandler = (
  req: unknown,
  res: unknown,
  bot?: unknown,
  next?: unknown
) => unknown

export type HttpRoute = {
  method?: string
  path?: string
  handler?: HttpRouteHandler
  middleware?: unknown[]
  systemAuth?: unknown
}

export type HttpApiOptions = {
  name?: string
  dsc?: string
  routes?: HttpRoute[]
  priority?: number
  enable?: boolean
  init?: (this: HttpApi, app: unknown, bot: unknown) => unknown
  ws?: Record<string, unknown>
  middleware?: unknown[]
}

type ExpressLikeApp = {
  use: (...args: unknown[]) => unknown
} & Record<string, unknown>

export type WsHandlerFn = ((
  conn: unknown,
  req: unknown,
  bot?: unknown,
  socket?: unknown,
  head?: unknown
) => unknown) & {
  __ownerKey?: string
  __originalHandler?: unknown
  skipAuth?: boolean
  handler?: unknown
}

export type AgentRuntimeBot = {
  wsf?: Record<string, WsHandlerFn[]>
  checkApiAuthorization?: (req: unknown) => boolean
}

type ExpressLikeReq = { agentRuntime?: unknown; api?: HttpApi }
type ExpressLikeRes = { headersSent?: boolean }

/**
 * HTTP API基础类
 * 提供统一的HTTP API接口结构，支持路由注册、WebSocket处理、中间件等。
 * handler 应使用 HttpResponse.success（普通对象拍平到顶层，禁默认 json.data）。
 */
export default class HttpApi {
  _wsDisposers: Array<() => void> = []
  name: string
  dsc: string
  routes: HttpRoute[]
  priority: number
  enable: boolean
  initHook: ((this: HttpApi, app: unknown, bot: unknown) => unknown) | null
  wsHandlers: Record<string, unknown>
  middleware: unknown[]
  createTime: number
  key?: string
  filePath?: string

  constructor(data: HttpApiOptions = {}) {
    this.name = data.name || 'unnamed-api'
    this.dsc = data.dsc || '暂无描述'
    this.routes = data.routes || []
    this.priority = data.priority || 100
    this.enable = data.enable !== false
    this.initHook = data.init || null
    this.wsHandlers = data.ws || {}
    this.middleware = data.middleware || []
    this.createTime = Date.now()
  }

  async init(app: ExpressLikeApp, bot: AgentRuntimeBot) {
    if (this.middleware && this.middleware.length > 0) {
      for (const mw of this.middleware) {
        if (typeof mw === 'function') {
          app.use(mw)
        }
      }
    }

    this.registerRoutes(app, bot)
    this._disposeWebSocketHandlers()
    this._wsDisposers = this.registerWebSocketHandlers(bot, this.key || this.name || 'unknown')

    if (typeof this.initHook === 'function') {
      await this.initHook.call(this, app, bot)
    }

    return true
  }

  registerRoutes(app: ExpressLikeApp, bot: AgentRuntimeBot) {
    if (!Array.isArray(this.routes) || this.routes.length === 0) return

    for (const route of this.routes) {
      const { method, path, handler, middleware = [] } = route

      if (!method || !path || !handler) {
        RuntimeUtil.makeLog(
          'warn',
          `[HttpApi] ${this.name} 路由配置不完整: method=${method}, path=${path}`,
          'HttpApi'
        )
        continue
      }

      const lowerMethod = method.toLowerCase()
      const register = app[lowerMethod]
      if (typeof register !== 'function') {
        RuntimeUtil.makeLog(
          'error',
          `[HttpApi] ${this.name} 不支持的HTTP方法: ${method}`,
          'HttpApi'
        )
        continue
      }

      const wrappedHandler = this.wrapHandler(handler, bot, this._withDefaultSystemAuth(route))

      // Express 方法必须带 app 作 this；拆出后裸调会触发 lazyrouter undefined
      if (middleware.length > 0) {
        ;(register as (this: ExpressLikeApp, ...args: unknown[]) => unknown).call(
          app,
          path,
          ...middleware,
          wrappedHandler,
        )
      } else {
        ;(register as (this: ExpressLikeApp, ...args: unknown[]) => unknown).call(
          app,
          path,
          wrappedHandler,
        )
      }
    }
  }

  _withDefaultSystemAuth(route: HttpRoute) {
    if (route.systemAuth === false) return route
    if (route.systemAuth != null && route.systemAuth !== '') return route
    const p = route.path
    if (typeof p !== 'string' || !p.startsWith('/api/')) return route
    const ctx =
      p
        .replace(/^\/api\//, '')
        .replace(/[/:*?]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '') || 'api'
    return { ...route, systemAuth: ctx }
  }

  wrapHandler(handler: HttpRouteHandler, bot: AgentRuntimeBot, route: HttpRoute = {}) {
    return async (req: ExpressLikeReq, res: ExpressLikeRes, next: unknown) => {
      if (res.headersSent) return

      try {
        req.agentRuntime = bot
        req.api = this
        if (route.systemAuth) {
          const ctx = typeof route.systemAuth === 'string' ? route.systemAuth : this.name
          const authResp = ensureSystemCoreAuth(
            req as Parameters<typeof ensureSystemCoreAuth>[0],
            res as Parameters<typeof ensureSystemCoreAuth>[1],
            bot,
            ctx
          )
          if (authResp) return authResp
        }
        await handler(req, res, bot, next)
      } catch (error: unknown) {
        if (!res.headersSent) {
          HttpResponse.error(
            res as Parameters<typeof HttpResponse.error>[0],
            error,
            500,
            `${this.name}.route`
          )
        } else {
          RuntimeUtil.makeLog(
            'error',
            `[HttpApi] ${this.name} 处理请求失败: ${normalizeError(error).message}`,
            'HttpApi',
            true
          )
        }
      }
    }
  }

  registerWebSocketHandlers(bot: AgentRuntimeBot, ownerKey = 'unknown') {
    if (!this.wsHandlers || typeof this.wsHandlers !== 'object') {
      return []
    }

    if (!bot.wsf) {
      bot.wsf = {}
    }

    const disposers: Array<() => void> = []

    for (const [path, handlers] of Object.entries(this.wsHandlers)) {
      if (!bot.wsf[path]) {
        bot.wsf[path] = []
      }

      const handlerArray = Array.isArray(handlers) ? handlers : [handlers]

      for (const handlerEntry of handlerArray) {
        const rawHandler =
          typeof handlerEntry === 'function'
            ? handlerEntry
            : handlerEntry &&
                typeof handlerEntry === 'object' &&
                typeof (handlerEntry as { handler?: unknown }).handler === 'function'
              ? (handlerEntry as { handler: WsHandlerFn }).handler
              : null
        if (typeof rawHandler === 'function') {
          const wrapped: WsHandlerFn = (conn, req, socket, head) => {
            try {
              rawHandler(conn, req, bot, socket, head)
            } catch (error: unknown) {
              RuntimeUtil.makeLog(
                'error',
                `[HttpApi] ${this.name} WebSocket处理失败: ${normalizeError(error).message}`,
                'HttpApi',
                true
              )
            }
          }
          wrapped.__ownerKey = ownerKey
          wrapped.__originalHandler = rawHandler
          if (handlerEntry && typeof handlerEntry === 'object' && (handlerEntry as { skipAuth?: boolean }).skipAuth === true) {
            wrapped.skipAuth = true
            wrapped.handler = wrapped
          }

          const exists = bot.wsf[path].some(
            (h) => h && h.__ownerKey === ownerKey && h.__originalHandler === rawHandler
          )
          if (exists) continue

          bot.wsf[path].push(wrapped)
          disposers.push(() => {
            const list = bot.wsf?.[path]
            if (!Array.isArray(list)) return
            const index = list.indexOf(wrapped)
            if (index >= 0) list.splice(index, 1)
            if (list.length === 0) delete bot.wsf?.[path]
          })
        }
      }
    }

    return disposers
  }

  _disposeWebSocketHandlers() {
    for (const dispose of this._wsDisposers || []) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* ignore */
      }
    }
    this._wsDisposers = []
  }

  getInfo(): {
    name: string
    dsc: string
    priority: number
    routes: number
    ws?: number
    enable: boolean
    createTime: number
  } {
    return {
      name: this.name,
      dsc: this.dsc,
      priority: this.priority,
      routes: this.routes ? this.routes.length : 0,
      ws: this.wsHandlers ? Object.keys(this.wsHandlers).length : 0,
      enable: this.enable,
      createTime: this.createTime
    }
  }

  start() {
    this.enable = true
    RuntimeUtil.makeLog('info', `[HttpApi] ${this.name} 已启用`, 'HttpApi')
  }

  stop() {
    this._disposeWebSocketHandlers()
    this.enable = false
    RuntimeUtil.makeLog('info', `[HttpApi] ${this.name} 已停用`, 'HttpApi')
  }

  async reload(app: ExpressLikeApp, bot: AgentRuntimeBot) {
    RuntimeUtil.makeLog('info', `[HttpApi] ${this.name} 开始重载`, 'HttpApi')
    this.stop()
    await this.init(app, bot)
    this.start()
    RuntimeUtil.makeLog('info', `[HttpApi] ${this.name} 重载完成`, 'HttpApi')
  }
}
