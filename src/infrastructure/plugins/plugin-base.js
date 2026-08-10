import { getAiWorkflowHost } from '../ai-workflow/workflow-host.js'

const SymbolTimeout = Symbol('Timeout')
const SymbolResolve = Symbol('Resolve')

function resolveWorkflowHost() {
  return getAiWorkflowHost()
}

const ensureArray = (value) => {
  if (!value) return []
  return Array.isArray(value) ? value.filter(Boolean) : [value]
}

const normalizeRuleShape = (rule) => {
  if (!rule) return null
  if (typeof rule === 'string' || rule instanceof RegExp) {
    return { reg: rule }
  }
  if (typeof rule === 'object' && !Array.isArray(rule)) {
    return {
      ...rule,
      reg: rule.reg ?? rule.pattern ?? rule.source ?? rule.match
    }
  }
  return null
}

const normalizeRules = (rules) => ensureArray(rules)
  .map(normalizeRuleShape)
  .filter(Boolean)

const normalizeTaskShape = (task) => {
  if (!task || typeof task !== 'object') return null
  if (!task.cron || !task.fnc) return null
  return {
    name: task.name || '',
    cron: String(task.cron).trim(),
    fnc: task.fnc,
    log: task.log !== false,
    timezone: task.timezone,
    immediate: task.immediate === true
  }
}

const normalizeTasks = (tasks) => ensureArray(tasks)
  .map(normalizeTaskShape)
  .filter(Boolean)

const normalizeHandlers = (handlers) => {
  if (!handlers) return []
  const list = Array.isArray(handlers)
    ? handlers
    : Object.values(handlers)

  return list
    .map(handler => {
      if (!handler) return null
      if (typeof handler === 'string') {
        return { key: handler, fnc: handler }
      }
      if (typeof handler === 'function') {
        return { key: handler.name || 'handler', fnc: handler.name, ref: handler }
      }
      if (typeof handler === 'object') {
        const fnc = handler.fnc || handler.fn
        const key = handler.key || handler.event || fnc
        if (!fnc || !key) return null
        return {
          key,
          fnc,
          priority: handler.priority,
          once: handler.once === true
        }
      }
      return null
    })
    .filter(Boolean)
}

const normalizeEventSubscribe = (subs) => {
  if (!subs) return []
  if (Array.isArray(subs)) {
    return subs.map(item => {
      if (!item) return null
      if (typeof item === 'function') return null
      const eventType = item.eventType || item.event || item.type
      if (!eventType) return null
      if (typeof item.handler === 'function') {
        return { eventType, handler: item.handler }
      }
      if (typeof item.handler === 'string' || typeof item.fnc === 'string') {
        return { eventType, fnc: item.handler || item.fnc }
      }
      return null
    }).filter(Boolean)
  }

  return Object.entries(subs)
    .map(([eventType, handler]) => {
      if (!eventType) return null
      if (typeof handler === 'function') {
        return { eventType, handler }
      }
      if (typeof handler === 'string') {
        return { eventType, fnc: handler }
      }
      return null
    })
    .filter(Boolean)
}

const contextStore = new Map()

const getContextBucket = (key, create = false) => {
  if (!key) return null
  if (!contextStore.has(key) && create) {
    contextStore.set(key, new Map())
  }
  return contextStore.get(key) || null
}

const cleanupBucket = (key) => {
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
  constructor(options = {}) {
    this.name = options.name || "your-plugin"
    this.dsc = options.dsc || "无"
    this.event = options.event || "message"
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
      this.namespace = options.namespace || ""
    }
  }

  getWorkflow(name) {
    return resolveWorkflowHost()?.getWorkflow?.(name) ?? null
  }

  /**
   * 标准化的结果收集接口
   * - 插件方法可选择调用，用于向上层返回结构化结果
   * - 结果会挂在当前事件对象的 `_pluginResults` 数组上
   */
  pushResult(payload) {
    if (!this.e) return null

    if (!Array.isArray(this.e._pluginResults)) {
      this.e._pluginResults = []
    }

    const entry = {
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

  reply(msg = "", quote = false, data = {}) {
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
      ? (this.group_id || this.e?.group_id || '')
      : (this.user_id || this.e?.user_id || this.e?.device_id || '')
    return `${this.name}.${selfId}.${targetId}`
  }

  setContext(type, isGroup = false, time = 120, timeout = "操作超时已取消") {
    if (!type || !this.e) return null

    const key = this.conKey(isGroup)
    this.finish(type, isGroup)

    const bucket = getContextBucket(key, true)
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

  getContext(type, isGroup = false) {
    const key = this.conKey(isGroup)
    const bucket = getContextBucket(key)
    if (!bucket) return null

    if (!type) {
      return Object.fromEntries(bucket.entries())
    }

    return bucket.get(type) || null
  }

  finish(type, isGroup = false) {
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

  awaitContext(...args) {
    return new Promise(resolve => {
      const context = this.setContext("resolveContext", ...args)
      if (context) context[SymbolResolve] = resolve
    })
  }

  resolveContext(context) {
    const key = this.conKey(false)
    const bucket = getContextBucket(key)
    const storedContext = bucket?.get("resolveContext")
    const resolve = storedContext?.[SymbolResolve]
    
    this.finish("resolveContext")
    if (resolve && context) resolve(this.e)
  }

  /**
   * 前置检查方法，可通过重写实现自定义检查逻辑
   * @returns {Promise<boolean|string>} true-通过 false-跳过 'return'-停止
   */
  async accept() {
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
    };
  }
}
