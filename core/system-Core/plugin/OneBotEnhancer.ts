// @ts-nocheck
import runtimeConfig from '#infrastructure/config/config.js'
import RuntimeUtil from '#utils/runtime-util.js'
import EnhancerBase from '#infrastructure/plugins/enhancer-base.js'
import { EventNormalizer } from '#utils/event-normalizer.js'

export default class OneBotEnhancer extends EnhancerBase {
  constructor() {
    super({
      name: 'OneBot',
      dsc: '为OneBot事件挂载特定属性',
      event: 'onebot.*',
      tasker: 'onebot',
      priority: 100
    })
  }

  enhanceEvent(e) {
    super.enhanceEvent(e)
    EventNormalizer.normalizeOneBot(e)

    this.bindBotEntities(e)

    // 处理@消息
    this.processAtProperties(e)

    // 补充sender信息（EventNormalizer已处理基础字段，这里补充OneBot特有字段）
    if (e.user_id && e.sender) {
      // 优先使用friend的nickname
      if (e.friend?.nickname && !e.sender.nickname) {
        e.sender.nickname = e.friend.nickname
      }
      
      // 群成员信息优先于friend
      if (e.member) {
        if (e.member.nickname && !e.sender.nickname) {
          e.sender.nickname = e.member.nickname
        }
        if (e.member.card && !e.sender.card) {
          e.sender.card = e.member.card
        }
      }
    }
  }

  processAtProperties(e) {
    if (!e.message || !Array.isArray(e.message)) return

    const atList = []
    let atBot = false
    const selfId = e.self_id || e.bot?.self_id || e.bot?.uin

    for (const seg of e.message) {
      if (seg?.type !== 'at') continue
      // OneBot / NapCat 多为 { type:'at', data:{ qq } }，少数扁平 { qq }
      const qq = seg.qq ?? seg.user_id ?? seg.data?.qq ?? seg.data?.user_id
      if (qq == null || qq === '') continue
      const qqStr = String(qq)
      atList.push(qqStr)
      if (selfId != null && (qqStr === String(selfId) || qqStr === 'all')) {
        atBot = true
      }
    }

    if (atList.length > 0) {
      e.atList = atList
      e.at = atList[0]
    }

    if (atBot) {
      e.atBot = true
    }
  }

  applyAlias(e) {
    if (!e.group_id || !e.msg) return
    const groupCfg = runtimeConfig.getGroup(e.group_id) || {}
    const aliases = this.normalizeAliasList(groupCfg.botAlias)
    if (!aliases.length) return

    for (const alias of aliases) {
      if (alias && e.msg.startsWith(alias)) {
        e.msg = e.msg.slice(alias.length).trim()
        e.hasAlias = true
        break
      }
    }
  }

  async applyAutoRequest(e) {
    if (e.post_type !== 'request' || typeof e.approve !== 'function') return
    const auto = runtimeConfig.chatbot?.auto || {}
    try {
      if (e.request_type === 'friend' && auto.friend === 1) {
        await e.approve(true)
        RuntimeUtil.makeLog('info', `已自动同意加好友：${e.user_id}`, e.self_id)
      }
    } catch (err) {
      RuntimeUtil.makeLog('warn', `自动同意加好友失败: ${err?.message || err}`, e.self_id)
    }
  }

  async applyAutoQuitOnInvite(e) {
    if (e.post_type !== 'notice' || e.notice_type !== 'group' || e.sub_type !== 'invite') return
    const quitThreshold = Number(runtimeConfig.chatbot?.auto?.quit) || 0
    if (quitThreshold <= 0 || !e.group_id) return
    try {
      const group = e.group || e.bot?.pickGroup?.(e.group_id)
      const info = group?.getInfo ? await group.getInfo() : null
      const count = info?.member_count ?? info?.memberCount
      if (typeof count === 'number' && count < quitThreshold && group?.quit) {
        await group.quit()
        RuntimeUtil.makeLog('info', `群人数 ${count} < ${quitThreshold}，已自动退群 ${e.group_id}`, e.self_id)
      }
    } catch (err) {
      RuntimeUtil.makeLog('warn', `自动退群失败: ${err?.message || err}`, e.self_id)
    }
  }

  async applyConfigPolicies(e) {
    try {
      if (e.post_type === 'request') {
        await this.applyAutoRequest(e)
        return true
      }
      if (e.post_type === 'notice') {
        await this.applyAutoQuitOnInvite(e)
        return true
      }

      const chatbotCfg = runtimeConfig.chatbot || {}
      const {
        blacklist = {},
        whitelist = {},
        private: privateCfg = {},
        guild = {}
      } = chatbotCfg
      
      const blackQQ = blacklist?.qq || []
      const whiteQQ = whitelist?.qq || []
      const blackGroup = blacklist?.groups || []
      const whiteGroup = whitelist?.groups || []
      const disablePrivate = privateCfg?.disabled === true
      const disableMsg = privateCfg?.disabledMsg || '私聊功能已禁用'
      const passKeywords = privateCfg?.passKeywords || []
      const disableGuildMsg = guild?.disableMsg === true

      // 统一字符串转换和比较
      const toStr = (v) => (v === undefined || v === null ? '' : String(v))
      const inList = (list, id) =>
        Array.isArray(list) && list.length > 0 && id && list.map(toStr).includes(toStr(id))

      const groupId = toStr(e.group_id || '')
      const userId = toStr(e.user_id || '')

      // 检查频道消息（guild）
      if (disableGuildMsg && groupId && groupId.includes('-') && !e.isMaster) {
        return 'return'
      }
      
      // 检查群组黑白名单
      if (groupId) {
        if (inList(blackGroup, groupId) && !e.isMaster) {
          return 'return'
        }
        if (Array.isArray(whiteGroup) && whiteGroup.length > 0 && !inList(whiteGroup, groupId) && !e.isMaster) {
          return 'return'
        }
      }
      
      // 检查用户黑白名单
      if (userId) {
        if (inList(blackQQ, userId) && !e.isMaster) {
          return 'return'
        }
        if (Array.isArray(whiteQQ) && whiteQQ.length > 0 && !inList(whiteQQ, userId) && !e.isMaster) {
          return 'return'
        }
      }
      
      // 检查私聊功能
      if (disablePrivate && e.isPrivate && !e.isMaster) {
        const text = String(e.msg || e.plainText || e.raw_message || '')
        const adopted = Array.isArray(passKeywords) &&
          passKeywords.filter(Boolean).some((key) => text.includes(String(key)))

        if (!adopted) {
          try {
            if (typeof e.reply === 'function') {
              await e.reply(disableMsg)
            }
          } catch {
            // 静默失败
          }
          return 'return'
        }
      }

      return true
    } catch (error) {
      RuntimeUtil.makeLog('error', `OneBotEnhancer 配置策略应用失败: ${error.message}`, e.self_id)
      return true
    }
  }

  enforceReplyPolicy(e) {
    // 非群组、设备、stdin事件跳过
    if (!e.group_id || e.isDevice || e.isStdin) return true

    const groupCfg = runtimeConfig.getGroup(e.group_id) || {}
    const onlyReplyAt = groupCfg.onlyReplyAt ?? 0
    const aliases = this.normalizeAliasList(groupCfg.botAlias)

    // 未启用或别名为空，不拦截（空数组 [] 也视为未配置）
    if (onlyReplyAt === 0 || !aliases.length) return true

    if (onlyReplyAt === 2 && e.isMaster) return true
    if (e.hasAlias) return true
    if (e.atBot === true) return true

    return 'return'
  }

  /**
   * 标准化别名列表
   * @param {string|Array} alias - 别名或别名数组
   * @returns {Array} 标准化后的别名数组
   */
  normalizeAliasList(alias) {
    if (!alias) return []
    return Array.isArray(alias) ? alias.filter(Boolean) : [alias].filter(Boolean)
  }
}