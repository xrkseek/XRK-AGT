import PluginLoader from '#infrastructure/plugins/loader.js';
import RuntimeUtil from '#utils/runtime-util.js';

/**
 * 事件监听基类
 * 去重、event_id、tasker 标记；Tasker 特有属性由 markTasker 第二参传入。
 *
 * 标准事件接口：
 * - e.reply(segmentsOrText)
 * - e.getReply?() / e.getChatHistory?(…)
 * - e.message_id / e.event_id
 * - e.isGroup / e.isPrivate
 */
export default class ListenerBase {
  plugins = PluginLoader;
  processedEvents = new Set<string>();
  MAX_PROCESSED_EVENTS = 1000;
  bot: unknown = null;
  taskerId: string;

  /** @param taskerId tasker 短名（onebot / device / stdin / …） */
  constructor(taskerId = '') {
    this.taskerId = taskerId;
  }

  ensureEventId(e: Record<string, any>): string {
    if (e.event_id) return e.event_id;
    const postType = e.post_type || 'event';
    const randomId = RuntimeUtil.shortId();
    e.event_id = `${this.taskerId || 'event'}_${postType}_${Date.now()}_${randomId}`;
    return e.event_id;
  }

  /**
   * @returns true 可继续；false 已处理过
   */
  markProcessed(e: Record<string, any> | null | undefined): boolean {
    if (!e) return false;
    const eventId = this.ensureEventId(e);
    const uniqueKey = `${this.taskerId || 'event'}:${eventId}`;
    if (this.processedEvents.has(uniqueKey)) return false;
    this.processedEvents.add(uniqueKey);
    this.cleanupProcessedEvents();
    return true;
  }

  /**
   * 标记 tasker 短名与旗标（如 isOneBot / isDevice）
   */
  markTasker(e: Record<string, any> | null | undefined, extraFlags: Record<string, unknown> = {}): void {
    if (!e) return;
    if (this.taskerId && !e.tasker) {
      e.tasker = this.taskerId;
    }
    if (extraFlags && Object.keys(extraFlags).length > 0) {
      Object.assign(e, extraFlags);
    }
  }

  cleanupProcessedEvents(): void {
    if (this.processedEvents.size <= this.MAX_PROCESSED_EVENTS) return;
    const ids = Array.from(this.processedEvents);
    const toRemove = ids.slice(0, ids.length - this.MAX_PROCESSED_EVENTS);
    toRemove.forEach((id) => this.processedEvents.delete(id));
  }
}
