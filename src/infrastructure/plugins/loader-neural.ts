import RuntimeUtil from '#utils/runtime-util.js'
import { getRuntimeGlobal } from '#utils/runtime-globals.js'
import { normalizeError } from '#utils/normalize-error.js'

type LoggerLike = {
  debug?: (msg: unknown) => void
  error?: (msg: unknown, err?: unknown) => void
}

type AgentRuntimeLike = {
  em?: (eventType: string, event: Record<string, unknown>) => unknown
}

const gLogger = (): LoggerLike | undefined => getRuntimeGlobal<LoggerLike>('logger')
const gAgentRuntime = (): AgentRuntimeLike | undefined => getRuntimeGlobal<AgentRuntimeLike>('AgentRuntime')

type HistoryEntry = {
  event_id?: unknown
  event_type?: unknown
  event_data?: Record<string, unknown>
  timestamp?: number
  source?: unknown
}

type EventCallback = (data: unknown) => void

type NeuralHost = {
  eventDeduplicator: { isDuplicate: (data: unknown) => boolean }
  eventHistoryCache: { set: (key: string, value: unknown) => void }
  eventSubscribers: Map<string, EventCallback[]>
  recordEventHistory: (eventType: string, eventData: Record<string, unknown>) => void
  distributeToSubscribers: (eventType: string, eventData: unknown) => void
}

export const neuralMethods = {
  /**
   * 统一的事件历史过滤方法（减少冗余代码）
   */
  filterEventHistory(history: unknown[], filter: Record<string, unknown> = {}) {
    let filtered = [...history] as HistoryEntry[]

    if (filter.event_type) {
      filtered = filtered.filter((h) => h.event_type === filter.event_type)
    }
    if (filter.user_id) {
      filtered = filtered.filter((h) => h.event_data?.user_id === filter.user_id)
    }
    if (filter.device_id) {
      filtered = filtered.filter((h) => h.event_data?.device_id === filter.device_id)
    }
    if (filter.limit && typeof filter.limit === 'number') {
      filtered = filtered.slice(0, filter.limit)
    }

    return filtered
  },

  recordEventHistory(this: NeuralHost, eventType: string, eventData: Record<string, unknown>) {
    // 使用事件去重器检查是否重复
    if (this.eventDeduplicator.isDuplicate(eventData)) {
      // debug: 重复事件是内部技术细节
      gLogger()?.debug?.(`事件去重: ${eventType} - ${String(eventData.event_id || 'unknown')}`)
      return
    }

    const historyEntry: HistoryEntry = {
      event_id: eventData.event_id || Date.now().toString(),
      event_type: eventType,
      event_data: eventData,
      timestamp: Date.now(),
      source: eventData.tasker || eventData.device_id || 'internal'
    }

    // 存储到智能缓存
    const cacheKey = `${eventType}:${historyEntry.event_id}`
    this.eventHistoryCache.set(cacheKey, historyEntry)
  },

  distributeToSubscribers(this: NeuralHost, eventType: string, eventData: unknown) {
    const subscribers = this.eventSubscribers.get(eventType)
    if (!subscribers || subscribers.length === 0) return

    subscribers.forEach((callback) => {
      try {
        callback(eventData)
      } catch (error: unknown) {
        gLogger()?.error?.(`事件订阅回调执行失败 [${eventType}]`)
        gLogger()?.error?.(normalizeError(error))
      }
    })
  },

  subscribeEvent(this: NeuralHost, eventType: string, callback: EventCallback) {
    if (typeof eventType !== 'string' || !eventType.trim() || typeof callback !== 'function') {
      return () => {}
    }

    const type = eventType.trim()
    if (!this.eventSubscribers.has(type)) {
      this.eventSubscribers.set(type, [])
    }
    this.eventSubscribers.get(type)!.push(callback)

    return () => {
      const subscribers = this.eventSubscribers.get(type)
      const index = subscribers?.indexOf(callback)
      if (index !== undefined && index > -1) subscribers!.splice(index, 1)
    }
  },

  async emit(this: NeuralHost, eventType: string, eventData: Record<string, unknown>) {
    try {
      const postType = eventType.split('.')[0] || 'custom'
      const randomId = RuntimeUtil.shortId()
      const event: Record<string, unknown> = {
        ...eventData,
        post_type: postType,
        event_type: eventType,
        time: Math.floor(Date.now() / 1000),
        event_id: `custom_${Date.now()}_${randomId}`
      }

      this.recordEventHistory(eventType, event)
      gAgentRuntime()?.em?.(eventType, event)
      this.distributeToSubscribers(eventType, event)

      return { success: true, event_id: event.event_id }
    } catch (error: unknown) {
      gLogger()?.error?.('触发自定义事件失败', error)
      return { success: false, error: normalizeError(error).message }
    }
  }
}
