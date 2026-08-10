/**
 * 统一事件标准化器
 * 通用字段在此处理；Tasker 特有字段由各 Enhancer 挂载。
 */
import { normalizeEventTaskerFields } from '#utils/event-keys.js'

export class EventNormalizer {
  /**
   * 标准化事件基础字段
   * @param {Object} e - 事件对象
   * @param {Object} options - 标准化选项
   * @returns {Object} 标准化后的事件对象
   */
  static normalizeBase(e, options = {}) {
    if (!e) return e

    normalizeEventTaskerFields(e)

    e.post_type = e.post_type || options.defaultPostType || 'message'
    // 仅 message 补 message_type；notice/request/device 态事件不写假 private
    if (e.post_type === 'message') {
      e.message_type = e.message_type || options.defaultMessageType || (e.group_id ? 'group' : 'private')
    }
    e.time = e.time || Math.floor(Date.now() / 1000)
    if (!e.sub_type && options.defaultSubType) e.sub_type = options.defaultSubType

    if (!e.sender) e.sender = {}
    if (!e.sender.user_id) e.sender.user_id = e.user_id || options.defaultUserId || 'unknown'
    if (!e.user_id) e.user_id = e.sender.user_id
    if (!e.sender.nickname) e.sender.nickname = e.sender.card || e.sender.user_id || 'unknown'
    if (!e.sender.card) e.sender.card = e.sender.nickname

    return e
  }

  /**
   * 标准化消息字段
   * @param {Object} e - 事件对象
   * @returns {Object} 标准化后的事件对象
   */
  static normalizeMessage(e) {
    if (!e) return e

    if (!Array.isArray(e.message)) {
      e.message = e.message ? [{ type: 'text', text: String(e.message) }] : []
    }

    if (!e.raw_message && e.message.length > 0) {
      e.raw_message = e.message
        .map(seg => {
          if (seg.type === 'text') return seg.text || seg.data?.text || ''
          return `[${seg.type}]`
        })
        .join('')
    }

    if (e.command && !e.raw_message) {
      e.raw_message = e.command
    }

    if (!e.raw_message) {
      e.raw_message = e.text || ''
    }

    return e
  }

  /**
   * 标准化群组相关字段
   * @param {Object} e - 事件对象
   * @returns {Object} 标准化后的事件对象
   */
  static normalizeGroup(e) {
    if (!e) return e

    if (e.group_id && !e.group_name) {
      e.group_name = e.group?.name || e.group?.group_name || ''
    }

    if (e.group_id && e.post_type === 'message' && e.message_type !== 'group') {
      e.message_type = 'group'
    }

    return e
  }

  /**
   * 完整标准化（组合所有通用方法）
   * @param {Object} e - 事件对象
   * @param {Object} options - 标准化选项
   * @returns {Object} 标准化后的事件对象
   */
  static normalize(e, options = {}) {
    if (!e) return e

    this.normalizeBase(e, options)
    this.normalizeMessage(e)
    this.normalizeGroup(e)

    return e
  }

  /**
   * 标准化 OneBot 事件特有字段（Enhancer 调用）
   * @param {Object} e - 事件对象
   * @param {string} [_eventType] - 兼容旧签名，忽略
   * @returns {Object}
   */
  static normalizeOneBot(e, _eventType) {
    if (!e) return e
    e.tasker = 'onebot'
    e.isOneBot = true
    if (e.isOnebot != null) delete e.isOnebot
    e.isPrivate = e.message_type === 'private' || (!e.group_id && !!e.user_id)
    e.isGroup = e.message_type === 'group' || !!e.group_id
    return e
  }

  /**
   * 标准化 Device 事件特有字段（Enhancer 调用）
   */
  static normalizeDevice(e) {
    if (!e) return e
    e.tasker = 'device'
    e.isDevice = true
    e.isGroup = false
    e.isPrivate = true
    if (e.post_type === 'message' && !e.message_type) e.message_type = 'private'
    if (!e.sender) e.sender = {}
    if (!e.sender.nickname && e.device_name) {
      e.sender.nickname = e.device_name
      e.sender.card = e.sender.card || e.sender.nickname
    }
    return e
  }

  /**
   * 标准化 Stdin 事件特有字段（Enhancer 调用）
   */
  static normalizeStdin(e) {
    if (!e) return e
    e.tasker = 'stdin'
    e.isStdin = true
    if (e.command && (!Array.isArray(e.message) || e.message.length === 0)) {
      e.message = [{ type: 'text', text: e.command }]
    }
    return e
  }

  /** OneBot 消息：CQ 形态 → raw_message；补全 self_id / user_id */
  static normalizeOneBotMessage(e) {
    if (!e || e.post_type !== 'message') return e
    if (!e.raw_message && Array.isArray(e.message) && e.message.length > 0) {
      e.raw_message = e.message
        .map(seg => {
          if (seg.type === 'text') return seg.text || seg.data?.text || ''
          if (seg.type === 'at') {
            const qq = seg.qq ?? seg.user_id ?? seg.data?.qq ?? seg.data?.user_id ?? ''
            return `[CQ:at,qq=${qq}]`
          }
          if (seg.type === 'image') {
            const file = seg.url || seg.file || seg.data?.url || seg.data?.file || ''
            return `[CQ:image,file=${file}]`
          }
          if (seg.type === 'face') return `[CQ:face,id=${seg.id ?? seg.data?.id ?? ''}]`
          if (seg.type === 'reply') return `[CQ:reply,id=${seg.id ?? seg.data?.id ?? ''}]`
          if (seg.type === 'record') return `[CQ:record,file=${seg.file || seg.data?.file || ''}]`
          if (seg.type === 'video') return `[CQ:video,file=${seg.file || seg.data?.file || ''}]`
          if (seg.type === 'file') return `[CQ:file,file=${seg.file || seg.data?.file || ''}]`
          return `[${seg.type}]`
        })
        .join('')
      if (!e.msg) e.msg = e.raw_message
    }
    if (!e.self_id && e.bot?.uin) e.self_id = e.bot.uin
    if (!e.user_id && e.sender?.user_id) e.user_id = e.sender.user_id
    return e
  }
}
