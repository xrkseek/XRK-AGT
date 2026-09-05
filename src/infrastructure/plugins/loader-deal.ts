// @ts-nocheck — PluginLoader mixin（this 绑定在 Object.assign 之后）
import fs from 'fs/promises'
import runtimeConfig from '../config/config.js'
import PluginBase from './plugin-base.js'
import Runtime from './runtime.js'
import { errorHandler, ErrorCodes } from '#utils/error-handler.js'
import { normalizeError } from '#utils/normalize-error.js'
import { matchEventPattern as matchEventPatternFn } from '#utils/core-fs.js'
import { EventNormalizer } from '#utils/event-normalizer.js'
import {
  inferDefaultPostType,
  matchPluginEvent,
  resolveTaskerId,
} from '#utils/event-keys.js'
import RuntimeUtil from '#utils/runtime-util.js'
import { msgSegment } from '#utils/msg-segment.js'
import { scheduleMsgRecall, rememberSentMsgIds } from '#utils/msg-recall.js'
import { readMediaBuffer } from '#utils/entry-media.js'
import moment from 'moment'

const gLogger = (): any => (globalThis as any).logger

export const dealMethods: any = {
  async deal(e: any) {
    try {
      if (!e) return

      this.normalizeEventPayload(e)
      this.initEvent(e)
      const hasBypassPlugin = await this.checkBypassPlugins(e)

      const shouldContinue = await this.preCheck(e, hasBypassPlugin)
      if (!shouldContinue) return

      const msgResult = await this.dealMsg(e)
      // @ts-ignore - dealMsg 可能返回 'return' 字符串
      if (msgResult === 'return') return

      this.setupReply(e)
      await Runtime.init(e)
      await this.runPlugins(e, true)
      const handled = await this.runPlugins(e, false)

      if (!handled && e.post_type === 'message') gLogger()?.debug(`${e.logText} 暂无插件处理`)
    } catch (error: any) {
      errorHandler.handle(error, { context: 'deal', event: e?.logText, code: ErrorCodes.PLUGIN_EXECUTION_FAILED }, true)
      gLogger()?.error('处理事件错误', error)
    } finally {
      // 如果事件携带完成回调，则在插件链路结束后触发（用于 HTTP/STDIN 收集结果）
      try {
        if (e && typeof e._onDone === 'function') {
          const fn = e._onDone
          delete e._onDone
          fn(e)
        }
      } catch {}
    }
  },

  async dealMsg(e: any) {
    try {
      await this.parseMessage(e)
      this.setupEventProps(e)
      this.checkPermissions(e)
      this.addUtilMethods(e)
    } catch (error: any) {
      errorHandler.handle(error, { context: 'dealMsg', event: e?.logText, code: ErrorCodes.PLUGIN_EXECUTION_FAILED }, true)
      gLogger()?.error('处理消息内容错误', error)
    }
  },

  /**
   * Tasker 事件链统一入口：通用标准化。
   * Tasker 特有字段由各 Enhancer 挂载（见 docs/事件系统标准化文档.md）。
   * OneBot CQ → raw_message 须在 parseMessage 之前，故按 tasker 短名早做一次。
   */
  normalizeEventPayload(e: any) {
    if (!e) return
    // normalizeBase 内提升遗留 post_type/event_type，再补默认字段
    EventNormalizer.normalize(e, {
      defaultPostType: inferDefaultPostType(e),
      defaultMessageType: e.group_id ? 'group' : 'private',
      defaultUserId: e.user_id || e.device_id || e.sender?.user_id || 'unknown'
    })
    // OneBot CQ → raw_message 须赶在 parseMessage 前；其它 Tasker 由各自 Enhancer 处理
    if (resolveTaskerId(e) === 'onebot' && e.post_type === 'message') {
      EventNormalizer.normalizeOneBotMessage(e)
    }
    e.msg = ''
    e.img = []
    e.video = []
    e.audio = []
    e.plainText = this.extractMessageText(e)
  },

  async parseMessage(e: any) {
    // 重置msg，从message数组重新构建
    e.msg = ''
    if (!e.forwardIds) e.forwardIds = []

    for (const val of e.message) {
      if (!val?.type) continue

      switch (val.type) {
        case 'text':
          e.msg += this.dealText(val.text || '')
          break
        case 'image':
        case 'mface':
          if (val.url || val.file) e.img.push(val.url || val.file)
          break
        case 'video':
          if (val.url || val.file) e.video.push(val.url || val.file)
          break
        case 'audio':
        case 'record':
          if (val.url || val.file) e.audio.push(val.url || val.file)
          break
        case 'file':
          e.file = { name: val.name || val.file_name, fid: val.fid || val.file_id, size: val.size, url: val.url || val.file }
          if (!e.fileList) e.fileList = []
          e.fileList.push(e.file)
          break
        case 'forward': {
          const id = val.id || val.message_id || val.data?.id || val.data?.message_id
          if (id != null && id !== '') e.forwardIds.push(String(id))
          break
        }
      }
    }
  },

  setupEventProps(e: any) {
    if (!e) return
    if (!e.sender) e.sender = {}
    if (!e.logText || e.logText.includes('未知')) {
      const scope = e.group_id ? `group:${e.group_id}` : (e.user_id || '未知')
      e.logText = `[${e.tasker || '未知'}][${scope}]`
    }
  },

  checkPermissions(e: any) {
    // stdin和device(web)已在事件监听器中设置isMaster，跳过
    if (e.isStdin || (e.isDevice && e.device_type === 'web')) return
    
    const masterQQ = runtimeConfig.master?.[e.self_id] || runtimeConfig.masterQQ || []
    const masters = Array.isArray(masterQQ) ? masterQQ : [masterQQ]
    e.isMaster = masters.some(id => String(e.user_id) === String(id))
  },

  setupReply(e: any) {
    if (e._replySetup) return
    if (!e.reply || e.isDevice) return
    e._replySetup = true

    e.replyNew = e.reply
    e.reply = async (msg = '', quote = false, data = {}) => {
      if (!msg) return false

      try {
        if (e.isStdin) return await e.replyNew(msg, quote, data)

        if (e.isGroup && e.group) {
          if (e.group.mute_left > 0
            || (e.group.all_muted && !e.group.is_admin && !e.group.is_owner)) {
            return false
          }
        }

        let { recallMsg = 0, at = '', recallUser = true } = data
        if (!Array.isArray(msg)) msg = [msg]
        msg = msg.map(m => {
          if (Buffer.isBuffer(m) || m instanceof Uint8Array) return msgSegment.image(m)
          return m
        })

        if (at && e.isGroup) {
          const atId = at === true ? e.user_id : at
          const rawName = at === true ? (e.sender?.card || e.sender?.nickname || '') : ''
          const atName = rawName.length > 10 ? rawName.slice(0, 10) : rawName
          msg.unshift(msgSegment.at(String(atId), atName), '\n')
        }

        if (quote && e.message_id) {
          msg.unshift(msgSegment.reply(e.message_id))
        }

        if (!Array.isArray(e._replyOutputs)) e._replyOutputs = []
        e._replyOutputs.push(msg)

        let msgRes
        try {
          msgRes = await e.replyNew(msg, false)
        } catch (err: any) {
          const error = normalizeError(err)
          gLogger()?.debug(`发送消息错误: ${error.message}`)
          const textMsg = msg.map(m => typeof m === 'string' ? m : m?.text || '').join('')
          if (textMsg) {
            try {
              msgRes = await e.replyNew(textMsg)
            } catch (innerErr: any) {
              gLogger()?.debug(`纯文本发送也失败: ${innerErr.message}`)
              return { error: err }
            }
          }
        }

        const ids = rememberSentMsgIds(e, msgRes)
        if (msgRes && !ids.length && !msgRes.error) {
          gLogger()?.debug('reply 未解析到 message_id（NapCat 应为 data.message_id）')
        }

        // recallMsg：秒；默认兼撤用户原消息；recallUser:false 只撤 bot
        const recallSeconds = Number(recallMsg)
        if (recallSeconds > 0 && ids.length) {
          scheduleMsgRecall(e, ids, {
            delayMs: recallSeconds * 1000,
            alsoRecall: recallUser !== false && e.message_id ? [e.message_id] : [],
            logTag: 'ReplyRecall',
          })
        }

        this.count(e, 'send', msg)
        return msgRes
      } catch (error: any) {
        errorHandler.handle(error, { context: 'setupReply', code: ErrorCodes.PLUGIN_EXECUTION_FAILED }, true)
        gLogger()?.error('回复消息处理错误', error)
        return { error: error.message }
      }
    }
  },

  async runPlugins(e: any, isExtended: any = false) {
    if (!e) return false
    
    try {
      // 扩展插件（enhancer）在 isExtended=true 时执行
      // 普通插件在 isExtended=false 时执行，且排除 enhancer
      const plugins = await this.initPlugins(e, isExtended, !isExtended ? (meta: any) => meta.isEnhancer !== true : null)

      // 扩展插件直接处理规则
      if (isExtended) {
        return await this.processPlugins(plugins, e, true)
      }

      // 普通插件：先执行 accept 检查
      for (const plugin of plugins) {
        try {
          const res = await plugin.accept(e)
          
          // 处理需要重新解析消息的情况
          if (e._needReparse) {
            delete e._needReparse
            e.img = []
            e.video = []
            e.audio = []
            e.msg = ''
            await this.parseMessage(e)
          }
          
          // 如果插件返回 'return'，停止处理
          if (res === 'return') return true
          
          // 如果插件返回 false，跳过该插件
          if (res === false) continue
        } catch (error: any) {
          errorHandler.handle(error, { context: 'runPlugins', pluginName: plugin.name, code: ErrorCodes.PLUGIN_EXECUTION_FAILED }, true)
          gLogger()?.error(`插件 ${plugin.name} accept错误`, error)
        }
      }

      // 上下文：所有事件都参与，便于点歌等“先发列表再等数字”在 device/web 下生效
      if (await this.handleContext(plugins, e)) return true
      if (!e.isDevice && !plugins.some(p => p.bypassThrottle === true)) {
        this.setLimit(e)
      }

      // 处理插件规则
      return await this.processPlugins(plugins, e, false)
    } catch (error: any) {
      errorHandler.handle(error, { context: 'runPlugins', code: ErrorCodes.PLUGIN_EXECUTION_FAILED }, true)
      gLogger()?.error('运行插件错误', error)
      return false
    }
  },

  async initPlugins(e: any, isExtended: any = false, filterFn: any = null) {
    if (!e) return []
    
    const pluginList = isExtended ? this.extended : this.priority
    const activePlugins = []

    for (const p of pluginList) {
      // 跳过无效插件
      if (!p?.class || (filterFn && !filterFn(p))) continue

      try {
        // 创建插件实例
        const plugin = new p.class(e)
        plugin.e = e
        // 元数据 event 为准，避免 constructor(e) 误把事件对象当 options 落到默认 message
        if (p.event) plugin.event = p.event

        // 应用规则模板
        this.applyRuleTemplates(plugin, p.ruleTemplates)
        
        // 包装 accept（含 tasker 白名单检查）
        plugin.accept = this.wrapPluginAccept(plugin, p)
        plugin.bypassThrottle = p.bypassThrottle

        // 检查插件是否启用且事件匹配
        if (this.checkDisable(plugin) && this.filtEvent(e, plugin)) {
          activePlugins.push(plugin)
        }
      } catch (error: any) {
        errorHandler.handle(error, { context: 'initPlugins', pluginName: p.name, code: ErrorCodes.PLUGIN_LOAD_FAILED }, true)
        gLogger()?.error(`初始化插件 ${p.name} 失败`, error)
      }
    }

    return activePlugins
  },

  async processPlugins(plugins: any, e: any, isExtended: any) {
    if (!Array.isArray(plugins) || !plugins.length) return false

    if (isExtended) return await this.processRules(plugins, e)

    // 按优先级分组
    const pluginsByPriority = {}
    for (const p of plugins) {
      const priority = p.priority || 50
      if (!pluginsByPriority[priority]) {
        pluginsByPriority[priority] = []
      }
      pluginsByPriority[priority].push(p)
    }
    const priorities = Object.keys(pluginsByPriority).map(Number).sort((a: any, b: any) => a - b)

    for (const priority of priorities) {
      const priorityPlugins = pluginsByPriority[priority]
      if (Array.isArray(priorityPlugins) && await this.processRules(priorityPlugins, e)) {
        return true
      }
    }

    return await this.processDefaultHandlers(e)
  },

  async processRules(plugins: any, e: any) {
    if (!Array.isArray(plugins) || !e) return false

    for (const plugin of plugins) {
      if (!plugin?.rule || !Array.isArray(plugin.rule)) continue

      for (const rule of plugin.rule) {
        // 检查事件类型匹配
        if (rule.event && !this.filtEvent(e, rule)) continue
        
        // 检查规则匹配（使用智能匹配器）
        const matchResult = this.pluginMatcher.matchRule(rule, e)
        if (!matchResult.matched) continue

        // 设置日志函数标识
        e.logFnc = `[${plugin.name}][${rule.fnc}]`
        
        // 记录日志（如果未禁用）
        if (rule.log !== false) {
          const msg = e.msg || ''
          const truncatedMsg = msg.length > 100 ? msg.substring(0, 97) + '...' : msg
          gLogger()?.info(`${e.logFnc}${e.logText} ${truncatedMsg}`)
        }

        // 检查权限
        if (!this.filtPermission(e, rule)) return true

        // 执行插件函数
        try {
          const start = Date.now()
          const fnc = plugin[rule.fnc]
          
          if (typeof fnc === 'function') {
            // 标记当前正在执行的插件方法，便于结果收集与调试
            e._currentRuleFnc = rule.fnc
            let res
            try {
              res = await fnc.call(plugin, e)
            } finally {
              delete e._currentRuleFnc
            }

            if (res !== false) {
              if (rule.log !== false) {
                gLogger()?.mark(`${e.logFnc}${e.logText} 处理完成 ${Date.now() - start}ms`)
              }
              return true
            }
          }
        } catch (error: any) {
          errorHandler.handle(error, { context: 'processRules', pluginName: plugin.name, rule: rule.fnc })
        }
      }
    }
    return false
  },

  async processDefaultHandlers(e: any) {
    if (e.isDevice) return false

    for (const handler of this.defaultMsgHandlers) {
      try {
        const plugin = new handler.class(e)
        plugin.e = e
        if (typeof PluginBase.handleNonMatchMsg === 'function') {
          const res = await plugin.handleNonMatchMsg(e)
          if (res === 'return' || res) return true
        }
      } catch (error: any) {
        errorHandler.handle(error, { context: 'processDefaultHandlers', handlerName: handler.name, code: ErrorCodes.PLUGIN_EXECUTION_FAILED }, true)
        gLogger()?.error(`默认消息处理器 ${handler.name} 执行错误`, error)
      }
    }
    return false
  },

  async handleContext(plugins: any) {
    if (!Array.isArray(plugins)) return false

    for (const plugin of plugins) {
      if (!plugin?.getContext) continue

      const contexts = { ...plugin.getContext(), ...plugin.getContext(false, true) }
      if (!contexts || Object.keys(contexts).length === 0) continue

      for (const fnc of Object.keys(contexts)) {
        // 须查实例方法（如 addContext），不是 PluginBase 原型
        if (typeof plugin[fnc] !== 'function') continue
        try {
          const ret = await plugin[fnc](contexts[fnc])
          if (ret !== 'continue' && ret !== false) return true
        } catch (error: any) {
          errorHandler.handle(error, { context: 'handleContext', pluginName: plugin.name, fnc, code: ErrorCodes.PLUGIN_EXECUTION_FAILED }, true)
          gLogger()?.error(`上下文方法 ${fnc} 执行错误`, error)
        }
      }
    }
    return false
  },

  initEvent(e: any) {
    if (!e) return
    
    // 确保 self_id 存在
    if (!e.self_id) {
      e.self_id = e.device_id || (e.tasker && e.tasker !== 'unknown' ? e.tasker : AgentRuntime.uin?.[0])
    }

    // 确保 bot 对象存在
    if (!e.bot) {
      const identity = e.device_id || e.self_id
      Object.defineProperty(e, 'bot', {
        value: identity && AgentRuntime[identity] ? AgentRuntime[identity] : AgentRuntime,
        writable: false,
        configurable: false
      })
    }

    // 确保 event_id 存在（如果 EventNormalizer 未设置）
    if (!e.event_id) {
      const postType = e.post_type || 'unknown'
      const randomId = RuntimeUtil.shortId()
      e.event_id = `${e.tasker || 'event'}_${postType}_${Date.now()}_${randomId}`
    }

    // 统计接收事件
    this.count(e, 'receive')
  },

  async preCheck(e: any, hasBypassPlugin: any = false) {
    if (!e) return false
    
    try {
      // 设备和stdin事件跳过检查
      if (e.isDevice || (e.tasker || '').toLowerCase() === 'stdin') {
        return true
      }

      const botUin = e.self_id || AgentRuntime.uin?.[0]
      
      // 检查是否忽略自己发送的消息
      if (runtimeConfig.agt?.system?.ignoreSelf !== false) {
        const sameId = String(e.user_id ?? '') === String(botUin ?? '')
        if (sameId) return false
      }

      // 开机命令特殊处理
      if (/^#开机$/.test(e.plainText || '')) {
        const masterQQ = runtimeConfig.master?.[e.self_id] || runtimeConfig.masterQQ || []
        const masters = Array.isArray(masterQQ) ? masterQQ : [masterQQ]
        if (masters.some(id => String(e.user_id) === String(id))) {
          return true
        }
      }

      // 热关机：进程仍在，仅忽略业务消息（#开机 仍放行）
      const shutdownStatus = await redis.get(`AGT:shutdown:${botUin}`)
      if (shutdownStatus === 'true') {
        gLogger()?.debug(`[热关机] 忽略消息: ${e.plainText || ''}`)
        return false
      }

      // 检查黑白名单（与 OneBotEnhancer 一致：统一转字符串）
      const chatbot = runtimeConfig.chatbot || {}
      const { blacklist = {}, whitelist = {} } = chatbot
      const groupId = String(e.group_id ?? '')
      const userId = String(e.user_id ?? '')
      const inList = (list: any, id: any) =>
        Array.isArray(list) && list.length > 0 && id && list.map(String).includes(String(id))

      if (inList(blacklist.groups, groupId) || inList(blacklist.qq, userId)) {
        return false
      }

      if (Array.isArray(whitelist.groups) && whitelist.groups.length && !inList(whitelist.groups, groupId)) {
        return false
      }
      if (Array.isArray(whitelist.qq) && whitelist.qq.length && !inList(whitelist.qq, userId)) {
        return false
      }

      // bypass插件跳过限流检查
      if (hasBypassPlugin) return true

      return this.checkLimit(e)
    } catch (error: any) {
      errorHandler.handle(error, { context: 'preCheck', code: ErrorCodes.PLUGIN_EXECUTION_FAILED }, true)
      gLogger()?.error('前置检查错误', error)
      return false
    }
  },

  async checkBypassPlugins(e: any) {
    const text = e.plainText || ''
    if (!text) return false

    for (const p of this.priority) {
      if (!p.bypassThrottle || !p.bypassRules?.length) continue
      if (!this.isTaskerAllowed(p.taskers, e)) continue

      try {
        if (p.bypassRules.some(rule => rule.reg?.test(text))) {
          return true
        }
      } catch (error: any) {
        errorHandler.handle(error, { context: 'checkBypassPlugins', pluginName: p.name, code: ErrorCodes.PLUGIN_EXECUTION_FAILED }, true)
        gLogger()?.error('检查bypass插件错误', error)
      }
    }

    return false
  },

  extractMessageText(e: any) {
    if (e.raw_message) return this.dealText(e.raw_message)
    const messages = Array.isArray(e.message) ? e.message : (e.message ? [e.message] : [])
    const text = messages.filter(msg => msg.type === 'text').map(msg => msg.text || '').join('')
    return this.dealText(text)
  },

  addUtilMethods(e: any) {
    e.getSendableMedia = async (media: any) => {
      if (!media) return null

      try {
        if (Buffer.isBuffer(media)) return media
        if (typeof media === 'string') {
          return await readMediaBuffer({ file: media, type: 'file' }, e.bot?.sendApi
            ? (action: any, params: any) => e.bot.sendApi(action, params)
            : undefined, { type: 'file' })
        }
        const type = String(media.type || 'image').toLowerCase()
        const sendApi = e.bot?.sendApi
          ? (action: any, params: any) => e.bot.sendApi(action, params)
          : undefined
        return await readMediaBuffer(media, sendApi, { type })
      } catch (error: any) {
        gLogger()?.error(`处理媒体文件失败: ${error.message}`)
      }
      return null
    }

    e.throttle = (key, duration = 1000) => {
      const userId = e.user_id || e.device_id
      const throttleKey = `${userId}:${key}`
      if (this.eventThrottle.has(throttleKey)) return false

      this.eventThrottle.set(throttleKey, Date.now())
      setTimeout(() => this.eventThrottle.delete(throttleKey), duration)
      return true
    }

    e.getEventHistory = (filter = {}) => {
      // 从智能缓存获取事件历史
      const allEntries = Array.from(this.eventHistoryCache.cache.values())
      return this.filterEventHistory(allEntries, filter)
    }
  },

  filtEvent(e: any, v: any) {
    if (!v?.event) return true
    return matchPluginEvent(v.event, e, (pattern: any, event: any) => this.matchEventPattern(pattern, event))
  },

  matchEventPattern(pattern: any, event: any) {
    return matchEventPatternFn(pattern, event)
  },

  filtPermission(e: any, v: any) {
    if (e.isDevice) return true
    if (!v.permission || v.permission === 'all' || e.isMaster) return true

    switch (v.permission) {
      case 'master':
        if (!e.isMaster) {
          e.reply('暂无权限，只有主人才能操作')
          return false
        }
        return true

      case 'owner':
        // 检查是否为群主（由 Tasker Enhancer 设置）
        if (!e.isGroup || !e.member?.is_owner) {
          e.reply('暂无权限，只有群主才能操作')
          return false
        }
        return true

      case 'admin':
        // 检查是否为管理员（由 Tasker Enhancer 设置）
        if (!e.isGroup || (!e.member?.is_owner && !e.member?.is_admin)) {
          e.reply('暂无权限，只有管理员才能操作')
          return false
        }
        return true

      default:
        return true
    }
  },

  checkLimit(e: any) {
    if (e.isDevice) return true

    if (!e.message || !e.group_id || ['cmd'].includes(e.tasker)) {
      return true
    }

    const config = runtimeConfig.getGroup(e.group_id) || {}
    const groupCD = config.groupGlobalCD || 0
    const singleCD = config.singleCD || 0

    if ((groupCD > 0 && this.cooldowns.group.has(e.group_id)) ||
      (singleCD > 0 && this.cooldowns.single.has(`${e.group_id}.${e.user_id}`))) {
      return false
    }

    const msgId = e.message_id ?
      `${e.user_id}:${e.message_id}` :
      `${e.user_id}:${Date.now()}:${Math.random()}`

    if (this.msgThrottle.has(msgId)) return false

    this.msgThrottle.set(msgId, Date.now())
    setTimeout(() => this.msgThrottle.delete(msgId), 5000)

    return true
  },

  setLimit(e: any) {
    if (e.isDevice || !e.message || !e.group_id || ['cmd'].includes(e.tasker)) return

    const config = runtimeConfig.getGroup(e.group_id) || {}
    const groupCD = config.groupGlobalCD || 0
    const singleCD = config.singleCD || 0

    if (groupCD > 0) {
      this.cooldowns.group.set(e.group_id, Date.now())
      setTimeout(() => this.cooldowns.group.delete(e.group_id), groupCD)
    }

    if (singleCD > 0) {
      const key = `${e.group_id}.${e.user_id}`
      this.cooldowns.single.set(key, Date.now())
      setTimeout(() => this.cooldowns.single.delete(key), singleCD)
    }
  },

  checkDisable(p: any) {
    if (!p) return false
    
    // 如果没有事件对象，直接返回插件本身的有效性
    if (!p.e) return !!p
    
    // 设备和私聊事件不检查群组配置
    if (p.e.isDevice || !p.e.group_id) return true

    // 检查群组配置
    const groupCfg = runtimeConfig.getGroup(p.e.group_id) || {}
    const { disable = [], enable = [] } = groupCfg

    // 如果在禁用列表中，返回 false
    if (disable.includes(p.name)) return false
    
    // 如果配置了启用列表，检查是否在列表中
    return enable.length === 0 || enable.includes(p.name)
  },

  /**
   * 处理文本规范化
   * @param {string} text - 文本内容
   * @returns {string}
   */
  dealText(text: any = '') {
    text = String(text ?? '')
    if (runtimeConfig.agt?.system?.['/→#']) text = text.replace(/^\s*\/\s*/, '#')
    return text
      .replace(/^\s*[＃井#]+\s*/, '#')
      .replace(/^\s*[\\*※＊]+\s*/, '*')
      .trim()
  },

  initEventSystem() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)

    this.cleanupTimer = setInterval(() => {
      try {
        this.cleanupThrottles()
        this.cleanupCooldowns()
      } catch (error: any) {
        errorHandler.handle(error, { context: 'cleanupTimer' })
      }
    }, 60000)
  },

  /**
   * 统一的节流清理
   */
  cleanupThrottles() {
    const now = Date.now()
    for (const [key, time] of this.eventThrottle) {
      if (now - time > 60000) this.eventThrottle.delete(key)
    }
    for (const [key, time] of this.msgThrottle) {
      if (now - time > 5000) this.msgThrottle.delete(key)
    }
  },

  /**
   * 统一的冷却清理
   */
  cleanupCooldowns() {
    const now = Date.now()
    for (const cooldownType of ['group', 'single']) {
      const cooldownMap = this.cooldowns[cooldownType]
      if (cooldownMap instanceof Map) {
        for (const [key, time] of cooldownMap) {
          if (now - time > 300000) {
            cooldownMap.delete(key)
          }
        }
      }
    }
  },

  async count(e: any, type: any, msg: any) {
    if (e.isDevice) return

    try {
      const checkImg = item => {
        if (item?.type === 'image' && item.file && Buffer.isBuffer(item.file)) {
          this.saveCount('screenshot', e.group_id)
        }
      }
      Array.isArray(msg) ? msg.forEach(checkImg) : checkImg(msg)
      if (type === 'send') this.saveCount('sendMsg', e.group_id)
    } catch (error: any) {
      gLogger()?.debug(`统计计数失败: ${error.message}`)
    }
  },

  async saveCount(type: any, groupId: any = '') {
    try {
      const base = groupId ? `AGT:count:group:${groupId}:` : 'AGT:count:'
      const dayKey = `${base}${type}:day:${moment().format('MMDD')}`
      const monthKey = `${base}${type}:month:${moment().month() + 1}`
      const keys = [dayKey, monthKey]

      if (!groupId) {
        keys.push(`${base}${type}:total`)
      }

      for (const key of keys) {
        await redis.incr(key)
        if (key.includes(':day:') || key.includes(':month:')) {
          await redis.expire(key, 3600 * 24 * 30)
        }
      }
    } catch (error: any) {
      gLogger()?.debug(`保存计数失败: ${error.message}`)
    }
  },

  /**
   * 删除计数
   */
  async delCount() {
    try {
      await Promise.all([
        redis.set('AGT:count:sendMsg:total', '0'),
        redis.set('AGT:count:screenshot:total', '0')
      ])
    } catch (error: any) {
      gLogger()?.debug(`删除计数失败: ${error.message}`)
    }
  }
}
