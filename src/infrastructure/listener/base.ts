import PluginLoader from '#infrastructure/plugins/loader.js'
import RuntimeUtil from '#utils/runtime-util.js'

/**
 * Listener 入站事件最小面（去重 / tasker 标记用）。
 * 完整事件契约见 docs/事件系统标准化文档.md。
 */
export type ListenerEvent = {
  event_id?: string
  post_type?: string
  tasker?: string
  message_id?: string | number
  isGroup?: boolean
  isPrivate?: boolean
  [key: string]: unknown
}

/**
 * 事件监听基类
 * 去重、event_id、tasker 标记；Tasker 特有属性由 markTasker 第二参传入。
 *
 * 标准事件接口：
 * - e.reply(segmentsOrText)
 * - e.getReply?() / e.getChatHistory?(…)
 * - e.message_id / e.event_id
 * - e.isGroup / e.isPrivate
 *
 * 生命周期（与原版一致）：
 * 1. ListenerLoader new 后注入 bot，再 await init()
 * 2. 订阅读 {短名}.message|notice|request
 * 3. handle：markProcessed → markTasker → plugins.deal(e)
 */
export default class ListenerBase {
  plugins = PluginLoader
  processedEvents = new Set<string>()
  MAX_PROCESSED_EVENTS = 1000
  bot: unknown = null
  taskerId: string

  /** @param taskerId tasker 短名（onebot / device / stdin / …） */
  constructor(taskerId = '') {
    this.taskerId = taskerId
  }

  ensureEventId(e: ListenerEvent): string {
    if (e.event_id) return String(e.event_id)
    const postType = e.post_type || 'event'
    const randomId = RuntimeUtil.shortId()
    e.event_id = `${this.taskerId || 'event'}_${postType}_${Date.now()}_${randomId}`
    return e.event_id
  }

  /**
   * @returns true 可继续；false 已处理过
   */
  markProcessed(e: ListenerEvent | null | undefined): boolean {
    if (!e) return false
    const eventId = this.ensureEventId(e)
    const uniqueKey = `${this.taskerId || 'event'}:${eventId}`
    if (this.processedEvents.has(uniqueKey)) return false
    this.processedEvents.add(uniqueKey)
    this.cleanupProcessedEvents()
    return true
  }

  /**
   * 标记 tasker 短名与旗标（如 isOneBot / isDevice）
   */
  markTasker(
    e: ListenerEvent | null | undefined,
    extraFlags: Record<string, unknown> = {}
  ): void {
    if (!e) return
    if (this.taskerId && !e.tasker) {
      e.tasker = this.taskerId
    }
    if (extraFlags && Object.keys(extraFlags).length > 0) {
      Object.assign(e, extraFlags)
    }
  }

  cleanupProcessedEvents(): void {
    if (this.processedEvents.size <= this.MAX_PROCESSED_EVENTS) return
    const ids = Array.from(this.processedEvents)
    const toRemove = ids.slice(0, ids.length - this.MAX_PROCESSED_EVENTS)
    toRemove.forEach((id) => this.processedEvents.delete(id))
  }
}
