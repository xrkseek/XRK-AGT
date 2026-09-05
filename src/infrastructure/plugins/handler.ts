/**
 * 事件处理器管理系统
 * 用于管理和调度各种事件的处理函数
 */

const gLogger = (): any => (globalThis as any).logger

type HandlerEntry = {
  priority: number
  fn: (...args: any[]) => any
  ns: string
  self: unknown
  key: string
}

class HandlerManager {
  events = new Map<string, HandlerEntry[]>()
  sortedCache = new Map<string, boolean>()

  /**
   * 添加事件处理器
   */
  add(runtimeConfig: {
    ns: string
    fn: (...args: any[]) => any
    self?: unknown
    priority?: number
    key?: string
    event?: string
  }) {
    const { ns, fn, self, priority = 500 } = runtimeConfig
    const key = runtimeConfig.key || runtimeConfig.event || ''

    // 参数验证
    if (!this._validateParams(key, fn, ns)) {
      return false
    }

    // 删除同命名空间的旧处理器
    this.del(ns, key)

    gLogger()?.mark?.(`[Handler][Reg]: [${ns}][${key}]`)

    // 获取或创建事件处理器数组
    const handlers = this._getOrCreateHandlers(key)

    // 创建并插入处理器
    const handler: HandlerEntry = { priority, fn, ns, self, key }
    const insertIndex = this._findInsertIndex(handlers, priority)
    handlers.splice(insertIndex, 0, handler)

    // 标记已排序
    this.sortedCache.set(key, true)

    return true
  }

  /**
   * 删除事件处理器
   */
  del(ns: string, key = '') {
    if (!ns) {
      gLogger()?.error?.('[Handler][Del]: 缺少命名空间参数')
      return 0
    }

    // 删除命名空间下所有处理器
    if (!key) {
      return this._deleteAllInNamespace(ns)
    }

    // 删除指定key的处理器
    return this._deleteHandler(ns, key)
  }

  /**
   * 调用事件处理器
   */
  async call(key: string, e: unknown, args?: unknown, allHandler = false) {
    const handlers = this.events.get(key)

    if (!handlers?.length) {
      gLogger()?.debug?.(`[Handler][Call]: 没有找到 [${key}] 的处理器`)
      return
    }

    // 遍历执行处理器
    for (const handler of handlers) {
      const result = await this._executeHandler(handler, e, args)

      if (result.done && !allHandler) {
        return result.value
      }
    }
  }

  /**
   * 调用所有处理器
   */
  async callAll() {
    // 功能暂时禁用
    // return this.call(key, e, args, true)
  }

  /**
   * 检查是否存在处理器
   */
  has(key: string) {
    return this.events.has(key) && (this.events.get(key)?.length || 0) > 0
  }

  /**
   * 获取处理器数量
   */
  count(key: string) {
    return this.events.get(key)?.length || 0
  }

  /**
   * 获取所有事件键名
   */
  getKeys() {
    return Array.from(this.events.keys())
  }

  /**
   * 清空所有处理器
   */
  clear() {
    this.events.clear()
    this.sortedCache.clear()
    gLogger()?.mark?.('[Handler][Clear]: 已清空所有处理器')
  }

  // ========== 私有方法 ==========

  _validateParams(key: string, fn: unknown, ns: string) {
    if (!key || typeof key !== 'string') {
      gLogger()?.error?.('[Handler][Add]: 事件键名无效')
      return false
    }

    if (typeof fn !== 'function') {
      gLogger()?.error?.(`[Handler][Add]: [${ns}][${key}] 处理函数必须是函数类型`)
      return false
    }

    if (!ns) {
      gLogger()?.error?.(`[Handler][Add]: [${key}] 缺少命名空间`)
      return false
    }

    return true
  }

  _getOrCreateHandlers(key: string) {
    if (!this.events.has(key)) {
      this.events.set(key, [])
    }
    return this.events.get(key)!
  }

  _deleteAllInNamespace(ns: string) {
    let deletedCount = 0
    for (const [eventKey] of this.events) {
      deletedCount += this.del(ns, eventKey)
    }
    return deletedCount
  }

  _deleteHandler(ns: string, key: string) {
    const handlers = this.events.get(key)
    if (!handlers?.length) return 0

    const originalLength = handlers.length
    const filteredHandlers = handlers.filter((h) => h.ns !== ns)
    const deletedCount = originalLength - filteredHandlers.length

    if (deletedCount > 0) {
      if (filteredHandlers.length === 0) {
        this.events.delete(key)
        this.sortedCache.delete(key)
      } else {
        this.events.set(key, filteredHandlers)
      }

      gLogger()?.debug?.(
        `[Handler][Del]: 删除了 [${ns}][${key}] 的 ${deletedCount} 个处理器`
      )
    }

    return deletedCount
  }

  async _executeHandler(handler: HandlerEntry, e: unknown, args: unknown) {
    const { fn, self, ns, key } = handler
    let done = true

    // reject函数用于标记处理失败
    const reject = (msg = '') => {
      if (msg) {
        gLogger()?.mark?.(`[Handler][Reject]: [${ns}][${key}] ${msg}`)
      }
      done = false
    }

    try {
      const value = await fn.call(self, e, args, reject)

      if (done) {
        gLogger()?.mark?.(`[Handler][Done]: [${ns}][${key}]`)
      }

      return { done, value }
    } catch (error: any) {
      gLogger()?.error?.(`[Handler][Error]: [${ns}][${key}] 执行出错:`)
      gLogger()?.error?.(error.stack || error)
      return { done: false, value: undefined }
    }
  }

  /**
   * 二分查找插入位置
   */
  _findInsertIndex(handlers: HandlerEntry[], priority: number) {
    let left = 0
    let right = handlers.length

    while (left < right) {
      const mid = Math.floor((left + right) / 2)
      if (handlers[mid].priority <= priority) {
        left = mid + 1
      } else {
        right = mid
      }
    }

    return left
  }
}

// 创建单例实例
const handlerInstance = new HandlerManager()

// 导出静态接口
const Handler = {
  add: handlerInstance.add.bind(handlerInstance),
  del: handlerInstance.del.bind(handlerInstance),
  call: handlerInstance.call.bind(handlerInstance),
  callAll: handlerInstance.callAll.bind(handlerInstance),
  has: handlerInstance.has.bind(handlerInstance),
  count: handlerInstance.count.bind(handlerInstance),
  getKeys: handlerInstance.getKeys.bind(handlerInstance),
  clear: handlerInstance.clear.bind(handlerInstance)
}

export default Handler
