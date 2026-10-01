import { getAiWorkflowHost } from '../ai-workflow/workflow-host.js'

const SymbolTimeout = Symbol('Timeout')
const SymbolResolve = Symbol('Resolve')

type WorkflowHost = {
  getWorkflow?: (name: string) => unknown
}

function resolveWorkflowHost(): WorkflowHost | null {
  const host = getAiWorkflowHost()
  if (!host || typeof host !== 'object') return null
  return host as WorkflowHost
}

export type PluginResultEntry = {
  plugin: string
  method: string
  payload: unknown
}

export type PluginEvent = {
  reply?: (...args: any[]) => any
  bot?: any
  tasker?: any
  user_id?: string | number
  group_id?: string | number
  device_id?: string | number
  self_id?: string | number
  post_type?: string
  logText?: string
  isOnebot?: boolean
  isOneBot?: boolean
  runtime?: any
  friend?: any
  group?: any
  member?: any
  msg?: string
  raw_message?: string
  message?: any
  message_id?: string | number
  img?: any
  sender?: any
  isGroup?: boolean
  isMaster?: boolean
  recall?: (...args: any[]) => any
  getForwardMsg?: (...args: any[]) => any
  plainText?: string
  _pluginResults?: PluginResultEntry[]
  _currentRuleFnc?: string
  _needReparse?: boolean
  [SymbolTimeout]?: ReturnType<typeof setTimeout>
  [SymbolResolve]?: (value: unknown) => void
  [key: string]: any
}

export type PluginRule = Record<string, unknown> & { reg?: unknown }

export type PluginTask = {
  name: string
  cron?: string
  fnc: unknown
  log: boolean
  timezone?: unknown
  immediate?: boolean
}

export type PluginHandler = {
  key: string
  fnc: unknown
  ref?: (...args: unknown[]) => unknown
  priority?: unknown
  once?: boolean
}

export type PluginEventSubscribe = {
  eventType: string
  handler?: (...args: unknown[]) => unknown
  fnc?: string
}

export type PluginOptions = {
  name?: string
  dsc?: string
  event?: string
  priority?: number
  task?: unknown
  rule?: unknown
  handler?: unknown
  eventSubscribe?: unknown
  bypassThrottle?: boolean
  namespace?: string
  tasker?: string
}

const ensureArray = (value: unknown): unknown[] => {
  if (!value) return []
  return Array.isArray(value) ? value.filter(Boolean) : [value]
}

const normalizeRuleShape = (rule: unknown): PluginRule | null => {
  if (!rule) return null
  if (typeof rule === 'string' || rule instanceof RegExp) {
    return { reg: rule }
  }
  if (typeof rule === 'object' && !Array.isArray(rule)) {
    const obj = rule as Record<string, unknown>
    return {
      ...obj,
      reg: obj.reg ?? obj.pattern ?? obj.source ?? obj.match
    }
  }
  return null
}

const normalizeRules = (rules: unknown): PluginRule[] =>
  ensureArray(rules).map(normalizeRuleShape).filter((r): r is PluginRule => r != null)

const normalizeTaskShape = (task: unknown): PluginTask | null => {
  if (!task || typeof task !== 'object') return null
  const t = task as Record<string, unknown>
  if (!t.cron || !t.fnc) return null
  return {
    name: (t.name as string) || '',
    cron: String(t.cron).trim(),
    fnc: t.fnc,
    log: t.log !== false,
    timezone: t.timezone,
    immediate: t.immediate === true
  }
}

const normalizeTasks = (tasks: unknown): PluginTask[] =>
  ensureArray(tasks).map(normalizeTaskShape).filter((t): t is PluginTask => t != null)

const normalizeHandlers = (handlers: unknown): PluginHandler[] => {
  if (!handlers) return []
  const list = Array.isArray(handlers) ? handlers : Object.values(handlers as object)

  return list
    .map((handler: unknown): PluginHandler | null => {
      if (!handler) return null
      if (typeof handler === 'string') {
        return { key: handler, fnc: handler }
      }
      if (typeof handler === 'function') {
        const fn = handler as (...args: unknown[]) => unknown
        return { key: fn.name || 'handler', fnc: fn.name, ref: fn }
      }
      if (typeof handler === 'object') {
        const obj = handler as Record<string, unknown>
        const fnc = obj.fnc || obj.fn
        const key = obj.key || obj.event || fnc
        if (!fnc || !key) return null
        return {
          key: String(key),
          fnc,
          priority: obj.priority,
          once: obj.once === true
        }
      }
      return null
    })
    .filter((h): h is PluginHandler => h != null)
}

const normalizeEventSubscribe = (subs: unknown): PluginEventSubscribe[] => {
  if (!subs) return []
  if (Array.isArray(subs)) {
    return subs
      .map((item: unknown): PluginEventSubscribe | null => {
        if (!item) return null
        if (typeof item === 'function') return null
        if (typeof item !== 'object') return null
        const obj = item as Record<string, unknown>
        const eventType = obj.eventType || obj.event || obj.type
        if (!eventType) return null
        if (typeof obj.handler === 'function') {
          return { eventType: String(eventType), handler: obj.handler as (...args: unknown[]) => unknown }
        }
        if (typeof obj.handler === 'string' || typeof obj.fnc === 'string') {
          return { eventType: String(eventType), fnc: String(obj.handler || obj.fnc) }
        }
        return null
      })
      .filter((s): s is PluginEventSubscribe => s != null)
  }

  return Object.entries(subs as Record<string, unknown>)
    .map(([eventType, handler]): PluginEventSubscribe | null => {
      if (!eventType) return null
      if (typeof handler === 'function') {
        return { eventType, handler: handler as (...args: unknown[]) => unknown }
      }
      if (typeof handler === 'string') {
        return { eventType, fnc: handler }
      }
      return null
    })
    .filter((s): s is PluginEventSubscribe => s != null)
}

const contextStore = new Map<string, Map<string, PluginEvent>>()

const getContextBucket = (key: string, create = false) => {
  if (!key) return null
  if (!contextStore.has(key) && create) {
    contextStore.set(key, new Map())
  }
  return contextStore.get(key) || null
}

const cleanupBucket = (key: string) => {
  const bucket = contextStore.get(key)
  if (bucket && bucket.size === 0) {
    contextStore.delete(key)
  }
}

/**
 * 插件基类
 * 提供事件处理、工作流集成、上下文管理等功能。
 * 支持跨 Tasker 事件监听：message / onebot.* / device.* / stdin.*
 */

export default class PluginBase {
  name: string
  dsc: string
  event: string
  priority: number
  task: PluginTask[] | null
  rule: PluginRule[]
  bypassThrottle: boolean
  handler: PluginHandler[] | null
  eventSubscribe: PluginEventSubscribe[] | null
  namespace?: string
  e!: any
  group_id?: string | number
  user_id?: string | number

  constructor(options: PluginOptions = {}) {
    this.name = options.name || 'your-plugin'
    this.dsc = options.dsc || '无'
    this.event = options.event || 'message'
    this.priority = options.priority || 5000
    const normalizedTasks = normalizeTasks(options.task)
    const normalizedHandlers = normalizeHandlers(options.handler)
    const normalizedEvents = normalizeEventSubscribe(options.eventSubscribe)
    const normalizedRules = normalizeRules(options.rule)

    this.task = normalizedTasks.length ? normalizedTasks : null
    this.rule = normalizedRules || []
    this.bypassThrottle = options.bypassThrottle || false
    this.handler = normalizedHandlers.length ? normalizedHandlers : null
    this.eventSubscribe = normalizedEvents.length ? normalizedEvents : null

    if (options.handler) {
      this.namespace = options.namespace || ''
    }
  }

  getWorkflow(name: string) {
    return resolveWorkflowHost()?.getWorkflow?.(name) ?? null
  }

  /**
   * 标准化的结果收集接口
   * - 插件方法可选择调用，用于向上层返回结构化结果
   * - 结果会挂在当前事件对象的 `_pluginResults` 数组上
   */
  pushResult(payload: unknown) {
    if (!this.e) return null

    if (!Array.isArray(this.e._pluginResults)) {
      this.e._pluginResults = []
    }

    const entry: PluginResultEntry = {
      plugin: this.name,
      method: this.e._currentRuleFnc || '',
      payload
    }

    this.e._pluginResults.push(entry)
    return entry
  }

  /**
   * 读取当前事件上已收集到的所有插件结果
   */
  getResults() {
    if (!this.e || !Array.isArray(this.e._pluginResults)) return []
    return this.e._pluginResults
  }

  reply(msg: unknown = '', quote = false, data: Record<string, unknown> = {}) {
    if (!this.e || !msg) return false

    if (this.e.reply && typeof this.e.reply === 'function') {
      return this.e.reply(msg, quote, data)
    }

    if (this.e.bot?.sendMsg) {
      return this.e.bot.sendMsg(msg, quote, data)
    }

    if (this.e.tasker && this.e.bot?.tasker?.sendMsg) {
      return this.e.bot.tasker.sendMsg(this.e, msg)
    }

    return false
  }

  markNeedReparse() {
    if (this.e) this.e._needReparse = true
  }

  conKey(isGroup = false) {
    const selfId = this.e?.self_id || ''
    const targetId = isGroup
      ? this.group_id || this.e?.group_id || ''
      : this.user_id || this.e?.user_id || this.e?.device_id || ''
    return `${this.name}.${selfId}.${targetId}`
  }

  setContext(type: string, isGroup = false, time = 120, timeout = '操作超时已取消') {
    if (!type || !this.e) return null

    const key = this.conKey(isGroup)
    this.finish(type, isGroup)

    const bucket = getContextBucket(key, true)!
    bucket.set(type, this.e)

    if (time > 0) {
      this.e[SymbolTimeout] = setTimeout(() => {
        const stored = bucket.get(type)
        if (!stored) return

        const resolve = stored[SymbolResolve]
        bucket.delete(type)
        cleanupBucket(key)

        resolve ? resolve(false) : this.reply(timeout, true)
      }, time * 1000)
    }

    return this.e
  }

  getContext(type?: string, isGroup = false) {
    const key = this.conKey(isGroup)
    const bucket = getContextBucket(key)
    if (!bucket) return null

    if (!type) {
      return Object.fromEntries(bucket.entries())
    }

    return bucket.get(type) || null
  }

  finish(type: string, isGroup = false) {
    if (!type) return

    const key = this.conKey(isGroup)
    const bucket = getContextBucket(key)
    if (!bucket) return

    const context = bucket.get(type)

    if (context) {
      const timeout = context[SymbolTimeout]
      const resolve = context[SymbolResolve]

      if (timeout) clearTimeout(timeout)
      if (resolve) resolve(true)

      bucket.delete(type)
      cleanupBucket(key)
    }
  }

  awaitContext(...args: [isGroup?: boolean, time?: number, timeout?: string]) {
    return new Promise((resolve) => {
      const context = this.setContext('resolveContext', ...args)
      if (context) context[SymbolResolve] = resolve
    })
  }

  resolveContext(context?: unknown) {
    const key = this.conKey(false)
    const bucket = getContextBucket(key)
    const storedContext = bucket?.get('resolveContext')
    const resolve = storedContext?.[SymbolResolve]

    this.finish('resolveContext')
    if (resolve && context) resolve(this.e)
  }

  /**
   * 前置检查方法，可通过重写实现自定义检查逻辑
   * @returns true-通过 false-跳过 'return'-停止
   */
  async accept(_e?: PluginEvent): Promise<boolean | string> {
    return true
  }

  getInfo() {
    return {
      name: this.name,
      dsc: this.dsc,
      event: this.event,
      priority: this.priority,
      bypassThrottle: this.bypassThrottle === true,
      namespace: this.namespace || '',
      rule: normalizeRules(this.rule),
      tasks: normalizeTasks(this.task),
      handlers: normalizeHandlers(this.handler),
      eventSubscribe: normalizeEventSubscribe(this.eventSubscribe)
    }
  }
}
