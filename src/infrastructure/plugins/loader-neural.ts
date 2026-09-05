import RuntimeUtil from '#utils/runtime-util.js'

type NeuralHost = {
  eventDeduplicator: { isDuplicate: (data: any) => boolean }
  eventHistoryCache: { set: (key: string, value: unknown) => void }
  eventSubscribers: Map<string, Array<(data: any) => void>>
  recordEventHistory: (eventType: string, eventData: Record<string, any>) => void
  distributeToSubscribers: (eventType: string, eventData: unknown) => void
}

const gLogger = (): any => (globalThis as any).logger
const gAgentRuntime = (): any => (globalThis as any).AgentRuntime

export const neuralMethods = {
  /**
   * 统一的事件历史过滤方法（减少冗余代码）
   */
  filterEventHistory(history: any[], filter: Record<string, any> = {}) {
    let filtered = [...history]

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

  recordEventHistory(this: NeuralHost, eventType: string, eventData: Record<string, any>) {
    // 使用事件去重器检查是否重复
    if (this.eventDeduplicator.isDuplicate(eventData)) {
      // debug: 重复事件是内部技术细节
      gLogger()?.debug?.(`事件去重: ${eventType} - ${eventData.event_id || 'unknown'}`)
      return
    }

    const historyEntry = {
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
      } catch (error) {
        gLogger()?.error?.(`事件订阅回调执行失败 [${eventType}]`)
        gLogger()?.error?.(error)
      }
    })
  },

  subscribeEvent(this: NeuralHost, eventType: string, callback: (data: any) => void) {
    if (typeof eventType !== 'string' || !eventType.trim() || typeof callback !== 'function') {
      return () => {}
    }

    eventType = eventType.trim()
    if (!this.eventSubscribers.has(eventType)) {
      this.eventSubscribers.set(eventType, [])
    }
    this.eventSubscribers.get(eventType)!.push(callback)

    return () => {
      const subscribers = this.eventSubscribers.get(eventType)
      const index = subscribers?.indexOf(callback)
      if (index !== undefined && index > -1) subscribers!.splice(index, 1)
    }
  },

  async emit(this: NeuralHost, eventType: string, eventData: Record<string, any>) {
    try {
      const postType = eventType.split('.')[0] || 'custom'
      const randomId = RuntimeUtil.shortId()
      const event = {
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
    } catch (error: any) {
      gLogger()?.error?.('触发自定义事件失败', error)
      return { success: false, error: error?.message }
    }
  }
}
