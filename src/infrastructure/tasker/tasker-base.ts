import { EventNormalizer } from '#utils/event-normalizer.js'
import RuntimeUtil from '#utils/runtime-util.js'

/**
 * Tasker 基类
 * 提供标准化的 AgentRuntime 实例创建和事件处理。
 * 约定：各 Tasker 派发事件前应通过 createEvent 或 EventNormalizer.normalize 统一事件形态，
 * 保证 group_id / user_id / message_type / isGroup / isPrivate / isDevice 等字段一致，便于插件与工作流按 key 区分群聊/私聊/设备。
 */
export class TaskerBase {
  /**
   * 创建标准化的AgentRuntime实例
   */
  static createBotInstance(options: Record<string, any>, bot: any) {
    const { id, name, type, info = {}, tasker } = options

    if (!id || !bot) {
      throw new Error('TaskerBase.createBotInstance: 缺少必要参数')
    }

    // 确保uin列表包含此AgentRuntime
    if (!bot.uin.includes(id)) {
      bot.uin.push(id)
    }

    // 创建标准化的AgentRuntime实例
    const botInstance = {
      // 基础属性
      uin: id,
      self_id: id,
      nickname: name,
      avatar: info.avatar || null,
      info: { ...info, user_id: id },

      // tasker 信息
      tasker: tasker || null,
      tasker_type: type,

      // 状态信息
      stat: {
        start_time: Math.floor(Date.now() / 1000),
        ...(info.stat || {})
      },

      // 版本信息
      version: info.version || {
        id: type,
        name: name,
        version: '1.0.5'
      },

      // 通用方法（所有 tasker 都支持）
      sendMsg: null, // 由 tasker 实现
      reply: null, // 由 tasker 实现

      // 可选方法（tasker 可选择性实现）
      recallMsg: null,
      getMsg: null,

      // 标记
      _ready: false,
      _initializing: false
    }

    // 保存到AgentRuntime实例
    bot[id] = botInstance

    return botInstance
  }

  /**
   * 创建标准化的事件对象
   * 使用 EventNormalizer 统一标准化逻辑
   */
  static createEvent(options: Record<string, any>, bot: any) {
    const { post_type, tasker_type, self_id, data = {} } = options

    if (!bot) {
      throw new Error('TaskerBase.createEvent: bot 参数必需')
    }

    // 获取AgentRuntime实例
    const botInstance = bot[self_id] || bot

    // 创建基础事件对象
    const event: Record<string, any> = {
      // 基础属性
      post_type: post_type || 'message',
      self_id: self_id || botInstance.self_id,
      time: Math.floor(Date.now() / 1000),

      // tasker 信息
      tasker: tasker_type || '',

      // AgentRuntime实例
      bot: botInstance,

      // 消息相关
      message: data.message || [],
      raw_message: data.raw_message || '',
      msg: '',

      // 用户相关
      user_id: data.user_id || null,
      sender: data.sender || {},

      // 群组相关
      group_id: data.group_id || null,

      // 设备相关
      device_id: data.device_id || null,
      device_name: data.device_name || null,

      // 原始数据（可含 event_type：仅非 message/notice/request 的设备态事件需要）
      ...data
    }

    // 使用 EventNormalizer 统一标准化
    EventNormalizer.normalize(event, {
      defaultPostType: post_type,
      defaultMessageType: data.message_type,
      defaultSubType: data.sub_type,
      defaultUserId: data.user_id
    })

    // 确保 event_id 存在
    if (!event.event_id) {
      const randomId = RuntimeUtil.shortId()
      event.event_id = `${tasker_type || 'event'}_${event.post_type}_${Date.now()}_${randomId}`
    }

    return event
  }

  /**
   * 触发标准化事件：`{tasker}.{post_type}`（设备态 online/data 等仍由调用方直接 em）
   */
  static emitEvent(taskerType: string, event: Record<string, any> | null | undefined, bot: any) {
    if (!event || !bot || !taskerType) return
    if (!event.tasker) event.tasker = taskerType
    const post = event.post_type || 'message'
    bot.em(`${taskerType}.${post}`, event)
  }
}
