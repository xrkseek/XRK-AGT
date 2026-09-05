// @ts-nocheck
import ListenerBase from '#infrastructure/listener/base.js'
import { errorHandler, ErrorCodes } from '#utils/error-handler.js'

export default class OneBotEvent extends ListenerBase {
  constructor() {
    super('onebot')
  }

  async init() {
    const bot = this.bot || AgentRuntime
    for (const t of ['message', 'notice', 'request']) {
      bot.on(`onebot.${t}`, (e) => this.handleEvent(e))
    }
  }

  /** 前置校验与标记，标准化由 loader 统一执行 */
  normalizeEventBase(e) {
    e.bot = e.bot || (e.self_id ? AgentRuntime[e.self_id] : null)
    if (!e.bot) {
      AgentRuntime.makeLog('warn', `AgentRuntime对象不存在，忽略事件：${e.self_id}`, e.self_id)
      return false
    }
    this.ensureEventId(e)
    if (!this.markProcessed(e)) {
      AgentRuntime.makeLog('debug', `事件已处理，跳过：${e.event_id}`, e.self_id)
      return false
    }
    this.markTasker(e, { isOneBot: true })
    return true
  }

  /**
   * 设置事件回复方法
   * @param {Object} e - 事件对象
   * 注意：此方法作为备用，优先由 OneBotEnhancer 插件设置正确的 reply 方法
   */
  setupReplyMethod(e) {
    // 如果已经有 reply 方法，不覆盖（可能由 OneBotEnhancer 插件设置）
    if (e.reply || !e.bot) return
    
    // 作为备用方案，尝试使用 group 或 friend 的 sendMsg
    // 注意：此时 group 和 friend 可能还未设置（由 OneBotEnhancer 设置）
    e.reply = async (msg = '') => {
      if (!msg) return false
      try {
        // 优先使用 group 的 sendMsg（群聊）
        if (e.group?.sendMsg) {
          return await e.group.sendMsg(msg)
        }
        // 其次使用 friend 的 sendMsg（私聊）
        if (e.friend?.sendMsg) {
          return await e.friend.sendMsg(msg)
        }
        // 最后尝试使用 tasker 的发送方法
        if (e.bot?.tasker) {
          const tasker = e.bot.tasker
          if (e.message_type === 'group' && e.group_id && tasker.sendGroupMsg) {
            return await tasker.sendGroupMsg({ ...e, group_id: e.group_id }, msg)
          }
          if (e.message_type === 'private' && e.user_id && tasker.sendFriendMsg) {
            return await tasker.sendFriendMsg({ ...e, user_id: e.user_id }, msg)
          }
        }
        // warn: 发送方法缺失需要关注
        AgentRuntime.makeLog("warn", `无法发送消息：找不到合适的发送方法`, e.self_id)
        return false
      } catch (error) {
        errorHandler.handle(
          error,
          { context: 'setupReplyMethod', selfId: e.self_id, code: ErrorCodes.SYSTEM_ERROR },
          true
        )
        // debug: 发送失败是技术细节
        AgentRuntime.makeLog("debug", `回复消息失败: ${error.message}`, e.self_id)
        return false
      }
    }
  }

  /**
   * 处理事件
   * @param {Object} e - 事件对象
   * @param {string} eventType - 事件类型
   */
  async handleEvent(e) {
    try {
      if (!this.normalizeEventBase(e)) return
      if (e.post_type === 'message') this.setupReplyMethod(e)
      await this.plugins.deal(e)
    } catch (error) {
      errorHandler.handle(
        error,
        { context: 'handleEvent', selfId: e?.self_id, code: ErrorCodes.SYSTEM_ERROR },
        true
      )
      AgentRuntime.makeLog("error", `处理OneBot事件失败: ${error.message}`, e?.self_id, error)
    }
  }

}

