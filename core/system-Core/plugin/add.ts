// @ts-nocheck
import runtimeConfig from '#infrastructure/config/config.js'
import fs from "node:fs/promises"
import path from "node:path"
import lodash from "lodash"
import crypto from "crypto"
import { isHttpRef, isEntryMediaRelPath, readImageBuffer, persistEntryMedia } from '#utils/entry-media.js'
import { collectForwardIds } from '#utils/onebot-message-seg.js'
import { inlineBinaryFromRef, isPathLike } from '#utils/media-ref.js'

export const messageMap = {}
export const bannedWordsMap = {}

const ENTRY_MEDIA_TYPES = new Set(['image', 'video', 'record', 'file'])

/** 添加词条上下文超时（秒），展开嵌套聊天记录可能较慢 */
const ADD_CONTEXT_TIMEOUT = 300

/** 规范化转发节点元信息 */
function normalizeNodeMeta(node) {
  return {
    nickname: node?.nickname || node?.sender?.nickname || node?.name || '匿名',
    user_id: node?.user_id || node?.sender?.user_id || node?.uin || 80000000,
    time: node?.time || Math.floor(Date.now() / 1000)
  }
}

function getNodeMessages(node) {
  if (Array.isArray(node?.message)) return node.message
  if (Array.isArray(node?.content)) return node.content
  return []
}

/** 递归收集消息段中的本地媒体文件路径 */
function collectSegmentFiles(segments, files) {
  if (!Array.isArray(segments)) return
  for (const item of segments) {
    if (!item || typeof item !== 'object') continue
    if (item.file) files.push(item.file)
    if (item.type === 'node' && Array.isArray(item.data)) {
      for (const node of item.data) collectSegmentFiles(getNodeMessages(node), files)
    }
  }
}

// 模块级配置变量
let messageDataPath = "data/messageJson/"
let bannedWordsPath = "data/bannedWords/"
let bannedImagesPath = "data/bannedWords/images/"
let configPath = "data/bannedWords/config/"

export class add extends PluginBase {
  constructor() {
    super({
      name: "添加消息",
      dsc: "添加消息和违禁词管理",
      event: "onebot.message",
      priority: 5000,
      rule: [
        {
          reg: "^#(全局)?(模糊)?(添加|删除)",
          fnc: "handleAddDel"
        },
        {
          reg: "^#(全局)?(消息|词条)",
          fnc: "list"
        },
        {
          reg: "^#(全局)?(葵葵)?(增加|删除)(模糊)?违禁词",
          fnc: "handleBannedWord",
          permission: "master"
        },
        {
          reg: "^#(全局)?(葵葵)?违禁词(列表|管理)?",
          fnc: "listBannedWords",
          permission: "master"
        },
        {
          reg: "^#(葵葵)?清空(模糊)?违禁词",
          fnc: "clearBannedWords",
          permission: "master"
        },
        {
          reg: "^#(葵葵)?违禁词(开启|关闭|状态)",
          fnc: "toggleBannedWords",
          permission: "master"
        },
        {
          reg: "",
          fnc: "getMessage",
          log: false
        }
      ]
    })
  }

  async init() {
    const agtCfg = runtimeConfig.agt || {}
    const filesCfg = agtCfg.files || {}
    messageDataPath = filesCfg.messageDataPath || "data/messageJson/"
    bannedWordsPath = filesCfg.bannedWordsPath || "data/bannedWords/"
    bannedImagesPath = filesCfg.bannedImagesPath || "data/bannedWords/images/"
    configPath = filesCfg.bannedConfigPath || "data/bannedWords/config/"
    
    await Promise.all([
      AgentRuntime.mkdir(messageDataPath),
      AgentRuntime.mkdir(bannedWordsPath),
      AgentRuntime.mkdir(bannedImagesPath),
      AgentRuntime.mkdir(configPath)
    ])
    await this.initAllBannedWords()
  }

  /** 处理添加删除 */
  async handleAddDel() {
    this.isFuzzy = this.e.msg.includes("模糊")
    return this.e.msg.includes("添加") ? this.add() : this.del()
  }

  /** 处理违禁词增加删除 */
  async handleBannedWord() {
    return this.e.msg.includes("增加") ? this.addBannedWord() : this.delBannedWord()
  }

  /** 初始化所有违禁词 */
  async initAllBannedWords() {
    try {
      const files = await fs.readdir(bannedWordsPath)
      const jsonFiles = files.filter(f => f.endsWith('.json'))
      await Promise.all(
        jsonFiles.map(f => this.initBannedWords(f.replace('.json', '')))
      )
    } catch (err) {
      logger.error(`初始化违禁词失败: ${err.message}`, err)
    }
  }

  /** 初始化群组违禁词 */
  async initBannedWords(groupId) {
    if (!groupId || bannedWordsMap[groupId]) return
    
    // 从runtimeConfig读取默认配置
    const groupCfg = runtimeConfig.getGroup(groupId) || {}
    bannedWordsMap[groupId] = {
      exact: new Set(),
      fuzzy: new Set(),
      images: new Map(),
      config: {
        enabled: groupCfg.bannedWords?.enabled !== false,
        muteTime: Number(groupCfg.bannedWords?.muteTime) || 720,
        warnOnly: groupCfg.bannedWords?.warnOnly === true,
        exemptRoles: Array.isArray(groupCfg.bannedWords?.exemptRoles) ? groupCfg.bannedWords.exemptRoles : []
      }
    }

    const filePath = `${bannedWordsPath}${groupId}.json`
    if (!await AgentRuntime.fsStat(filePath)) return

    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf8"))
      
      if (data.exact && Array.isArray(data.exact)) {
        data.exact.forEach(word => bannedWordsMap[groupId].exact.add(word))
      }
      if (data.fuzzy && Array.isArray(data.fuzzy)) {
        data.fuzzy.forEach(word => bannedWordsMap[groupId].fuzzy.add(word))
      }
      if (data.images && typeof data.images === 'object') {
        Object.entries(data.images).forEach(([hash, info]) => {
          bannedWordsMap[groupId].images.set(hash, info)
        })
      }
      if (data.config && typeof data.config === 'object') {
        Object.assign(bannedWordsMap[groupId].config, data.config)
      }
      
      logger.info(`[违禁词] 成功加载群组 ${groupId} 的违禁词配置`)
    } catch (err) {
      logger.error(`加载违禁词失败 ${filePath}: ${err.message}`, err)
    }
  }

  /** 保存违禁词到文件 */
  async saveBannedWords(groupId) {
    if (!groupId || !bannedWordsMap[groupId]) return
    
    try {
      const data = {
        exact: Array.from(bannedWordsMap[groupId].exact),
        fuzzy: Array.from(bannedWordsMap[groupId].fuzzy),
        images: Object.fromEntries(bannedWordsMap[groupId].images),
        config: bannedWordsMap[groupId].config
      }
      
      await fs.writeFile(`${bannedWordsPath}${groupId}.json`, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      logger.error(`保存违禁词失败 ${groupId}: ${err.message}`, err)
    }
  }

  /** 获取身份信息 */
  getRoleInfo(userId) {
    if (!this.e.isGroup) {
      return { role: 'member', roleName: '群员', isAdmin: false }
    }
    
    try {
      const member = this.e.group?.pickMember?.(userId)
      if (!member) {
        return { role: 'member', roleName: '群员', isAdmin: false }
      }
      
      const role = member.role || 'member'
      const roleMap = { owner: '群主', admin: '管理员', member: '群员' }
      
      return {
        role,
        roleName: roleMap[role] || '群员',
        isAdmin: ['owner', 'admin'].includes(role)
      }
    } catch (error) {
      logger.debug(`获取身份信息失败: ${error.message}`)
      return { role: 'member', roleName: '群员', isAdmin: false }
    }
  }

  /** 切换违禁词状态 */
  async toggleBannedWords() {
    await this.getGroupId()
    if (!this.group_id || !this.checkAuth()) return false

    await this.initBannedWords(this.group_id)
    
    if (!bannedWordsMap[this.group_id]) {
      return this.reply('❌ 违禁词配置未初始化')
    }
    
    const action = this.e.msg.match(/违禁词(开启|关闭|状态)/)?.[1]
    const config = bannedWordsMap[this.group_id].config
    
    if (action === '开启') {
      config.enabled = true
      await this.saveBannedWords(this.group_id)
      return this.reply('✅ 违禁词检测已开启')
    }
    
    if (action === '关闭') {
      config.enabled = false
      await this.saveBannedWords(this.group_id)
      return this.reply('❌ 违禁词检测已关闭')
    }
    
    // 显示状态
    const { exact, fuzzy, images } = bannedWordsMap[this.group_id]
    return this.reply([
      `违禁词检测状态：${config.enabled ? '✅ 开启' : '❌ 关闭'}`,
      `禁言时长：${config.muteTime}分钟`,
      `模式：${config.warnOnly ? '仅警告' : '警告+禁言'}`,
      `精确违禁词：${exact.size}个`,
      `模糊违禁词：${fuzzy.size}个`,
      `图片违禁词：${images.size}个`
    ].join('\n'))
  }

  /** 清空违禁词 */
  async clearBannedWords() {
    this.isFuzzy = this.e.msg.includes('模糊')
    this.isGlobal = this.e.msg.includes('全局')
    
    await this.getGroupId()
    if (!this.group_id || !this.checkAuth()) return false
    
    await this.initBannedWords(this.group_id)
    
    if (!bannedWordsMap[this.group_id]) {
      return this.reply('❌ 违禁词配置未初始化')
    }
    
    const type = this.isFuzzy ? 'fuzzy' : 'exact'
    const typeName = this.isFuzzy ? '模糊' : '精确'
    const groupType = this.isGlobal ? '全局' : '群组'
    const count = bannedWordsMap[this.group_id][type].size
    
    if (!count) {
      return this.reply(`没有${groupType}${typeName}违禁词需要清空`)
    }
    
    bannedWordsMap[this.group_id][type].clear()
    await this.saveBannedWords(this.group_id)
    await this.reply(`✅ 已清空 ${count} 个${groupType}${typeName}违禁词`)
    
    return this.listBannedWords()
  }

  /** 增加违禁词 */
  async addBannedWord() {
    this.isGlobal = this.e.msg.includes('全局')
    this.isFuzzy = this.e.msg.includes('模糊')
    
    await this.getGroupId()
    
    if (!this.group_id && !this.isGlobal) {
      return this.reply("请先在群内触发消息，确定添加的群，或使用 #全局增加违禁词")
    }

    if (!this.checkAuth()) return false
    
    await this.initBannedWords(this.group_id)
    
    if (!bannedWordsMap[this.group_id]) {
      return this.reply('❌ 违禁词配置未初始化')
    }

    const word = this.e.msg.match(/增加(模糊)?违禁词(.*)/)?.[2]?.trim()
    
    if (!word && !this.e.img?.length) {
      this.e._bannedWordContext = {
        group_id: this.group_id,
        isFuzzy: this.isFuzzy,
        isGlobal: this.isGlobal,
        words: [],
        images: []
      }
      this.setContext("addBannedWordContext")
      const groupType = this.isGlobal ? '全局' : '群组'
      return this.reply(`请发送要添加的${groupType}${this.isFuzzy ? '模糊' : '精确'}违禁词或图片，完成后发送#结束添加`, true, { at: true })
    }

    if (word) {
      const type = this.isFuzzy ? 'fuzzy' : 'exact'
      const groupType = this.isGlobal ? '全局' : '群组'
      bannedWordsMap[this.group_id][type].add(word)
      await this.saveBannedWords(this.group_id)
      await this.reply(`✅ 成功添加${groupType}${this.isFuzzy ? '模糊' : '精确'}违禁词：${word}`)
      return this.listBannedWords()
    }

    if (this.e.img?.length) {
      const msg = [`正在添加图片违禁词...`]
      for (const img of this.e.img) {
        const result = await this.addImageBannedWord(img, this.group_id)
        msg.push(result.success 
          ? [`✅ 成功添加图片违禁词`, msgSegment.image(result.path)]
          : `❌ 图片处理失败：${result.error}`
        )
      }
      await this.saveBannedWords(this.group_id)
      await this.reply(await AgentRuntime.makeForwardArray(msg.flat()))
      return this.listBannedWords()
    }
    
    return false
  }

  /** 添加图片违禁词 */
  async addImageBannedWord(imgUrl, groupId) {
    try {
      const refs = typeof imgUrl === 'object' && imgUrl !== null ? imgUrl : { url: imgUrl }
      const buffer = await readImageBuffer(refs, this._bindSendApi(), { persist: true })
      if (!buffer?.length) return { success: false, error: '下载图片失败' }

      const hash = crypto.createHash('md5').update(buffer).digest('hex')
      const groupImgPath = `${bannedImagesPath}${groupId}/`
      await AgentRuntime.mkdir(groupImgPath)

      const ext = String(refs.url || refs.file || '').match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg'
      const filePath = `${groupImgPath}${hash}.${ext}`

      await fs.writeFile(filePath, buffer)
      
      bannedWordsMap[groupId].images.set(hash, {
        path: filePath,
        desc: `图片违禁词_${new Date().toLocaleString()}`,
        addTime: Date.now()
      })
      
      return { success: true, path: filePath, hash }
    } catch (err) {
      logger.error(`添加图片违禁词失败: ${err}`)
      return { success: false, error: err.message }
    }
  }

  /** 添加违禁词上下文 */
  async addBannedWordContext() {
    const context = this.getContext("addBannedWordContext")
    if (!context?._bannedWordContext) return false
    
    const ctx = context._bannedWordContext
    Object.assign(this, { 
      group_id: ctx.group_id, 
      isFuzzy: ctx.isFuzzy, 
      isGlobal: ctx.isGlobal 
    })
    
    await this.initBannedWords(this.group_id)

    if (this.e.msg?.includes("#结束添加")) {
      this.finish("addBannedWordContext")
      
      if (!ctx.words.length && !ctx.images.length) {
        return this.reply("没有添加任何违禁词")
      }
      
      const msg = []
      const type = this.isFuzzy ? 'fuzzy' : 'exact'
      const typeName = this.isFuzzy ? '模糊' : '精确'
      const groupType = this.isGlobal ? '全局' : '群组'
      
      if (ctx.words.length) {
        ctx.words.forEach(word => bannedWordsMap[this.group_id][type].add(word))
        msg.push(`【${groupType}${typeName}违禁词】添加了 ${ctx.words.length} 个：`, 
          ...ctx.words.map(w => `- ${w}`))
      }
      
      if (ctx.images.length) {
        msg.push(`【${groupType}图片违禁词】添加了 ${ctx.images.length} 个：`)
        ctx.images.forEach(img => {
          bannedWordsMap[this.group_id].images.set(img.hash, img.info)
          msg.push(msgSegment.image(img.info.path))
        })
      }
      
      await this.saveBannedWords(this.group_id)
      msg.unshift(`✅ 成功添加 ${ctx.words.length + ctx.images.length} 个${groupType}违禁词`)
      await this.reply(await AgentRuntime.makeForwardArray(msg))
      return this.listBannedWords()
    }

    this.e.msg && !this.e.img?.length && ctx.words.push(this.e.msg.trim())
    
    if (this.e.img?.length) {
      for (const img of this.e.img) {
        const result = await this.addImageBannedWord(img, this.group_id)
        result.success && ctx.images.push({
          hash: result.hash,
          info: bannedWordsMap[this.group_id].images.get(result.hash)
        })
      }
    }
    
    this.e._bannedWordContext = ctx
    this.setContext("addBannedWordContext")
    
    const groupType = ctx.isGlobal ? '全局' : '群组'
    const status = [`继续发送要添加的${groupType}${this.isFuzzy ? '模糊' : '精确'}违禁词，或发送#结束添加`]
    ctx.words.length && status.push(`已添加文字：${ctx.words.length}个`)
    ctx.images.length && status.push(`已添加图片：${ctx.images.length}个`)
    
    return this.reply(status.join('\n'))
  }

  /** 删除违禁词 */
  async delBannedWord() {
    this.isGlobal = this.e.msg.includes('全局')
    this.isFuzzy = this.e.msg.includes('模糊')
    
    await this.getGroupId()
    
    if (!this.group_id && !this.isGlobal) {
      return this.reply("请先在群内触发消息，确定删除的群，或使用 #全局删除违禁词")
    }

    if (!this.checkAuth()) return false
    
    await this.initBannedWords(this.group_id)
    
    if (!bannedWordsMap[this.group_id]) {
      return this.reply('❌ 违禁词配置未初始化')
    }

    const param = this.e.msg.match(/删除(模糊)?违禁词(.*)/)?.[2]?.trim()
    if (!param) {
      return this.reply("删除错误：没有指定违禁词或序号")
    }

    const groupType = this.isGlobal ? '全局' : '群组'
    const num = parseInt(param)
    
    // 按序号删除
    if (!isNaN(num) && num > 0) {
      let deleted = false
      let deletedItem = ""
      
      if (this.isFuzzy) {
        const wordsList = Array.from(bannedWordsMap[this.group_id].fuzzy)
        if (num <= wordsList.length) {
          deletedItem = wordsList[num - 1]
          bannedWordsMap[this.group_id].fuzzy.delete(deletedItem)
          deleted = true
        }
      } else {
        const exactList = Array.from(bannedWordsMap[this.group_id].exact)
        const imagesList = Array.from(bannedWordsMap[this.group_id].images.entries())
        const totalList = [...exactList, ...imagesList]
        
        if (num <= totalList.length) {
          if (num <= exactList.length) {
            deletedItem = exactList[num - 1]
            bannedWordsMap[this.group_id].exact.delete(deletedItem)
          } else {
            const [hash, info] = imagesList[num - exactList.length - 1]
            deletedItem = `图片违禁词 (${info.desc})`
            bannedWordsMap[this.group_id].images.delete(hash)
            try { 
              await fs.unlink(info.path) 
            } catch (err) {
              logger.debug(`删除图片文件失败: ${err.message}`)
            }
          }
          deleted = true
        }
      }
      
      if (deleted) {
        await this.saveBannedWords(this.group_id)
        await this.reply(`✅ 成功删除${groupType}${this.isFuzzy ? '模糊' : '精确'}违禁词：${deletedItem}`)
        return this.listBannedWords()
      }
    }
    
    // 按关键词删除
    const type = this.isFuzzy ? 'fuzzy' : 'exact'
    if (bannedWordsMap[this.group_id][type].has(param)) {
      bannedWordsMap[this.group_id][type].delete(param)
      await this.saveBannedWords(this.group_id)
      await this.reply(`✅ 成功删除${groupType}${this.isFuzzy ? '模糊' : '精确'}违禁词：${param}`)
      return this.listBannedWords()
    }

    return this.reply(`❌ 删除错误：未找到该${groupType}${this.isFuzzy ? '模糊' : '精确'}违禁词`)
  }

  /** 违禁词列表 */
  async listBannedWords() {
    this.isGlobal = this.e.msg.includes('全局')
    
    await this.getGroupId()
    if (!this.group_id) {
      return this.reply("请先在群内触发消息")
    }

    await Promise.all([
      this.initBannedWords(this.group_id),
      this.initBannedWords('global')
    ])

    const banned = bannedWordsMap[this.group_id]
    const globalBanned = bannedWordsMap['global']
    
    if (!banned && (!globalBanned || this.group_id === 'global')) {
      return this.reply("暂无违禁词")
    }
    
    if (!banned && this.group_id !== 'global') {
      return this.reply("暂无群组违禁词")
    }

    const msg = []
    let totalNum = 0
    
    if (banned) {
      msg.push(
        `【违禁词检测状态】${banned.config.enabled ? '✅ 开启' : '❌ 关闭'}`,
        `禁言时长：${banned.config.muteTime}分钟`,
        `模式：${banned.config.warnOnly ? '仅警告' : '警告+禁言'}`,
        '━━━━━━━━━━━━━━━'
      )
      
      if (banned.exact.size) {
        msg.push(`【群组精确违禁词】共${banned.exact.size}个：`)
        for (const word of banned.exact) msg.push(`${++totalNum}. ${word}`)
      }
      
      if (banned.images.size) {
        msg.push(`【群组图片违禁词】共${banned.images.size}个：`)
        for (const [, info] of banned.images) {
          msg.push(`${++totalNum}. ${info.desc}`)
          await AgentRuntime.fsStat(info.path) && msg.push(msgSegment.image(info.path))
        }
      }
      
      if (banned.fuzzy.size) {
        msg.push('━━━━━━━━━━━━━━━', `【群组模糊违禁词】共${banned.fuzzy.size}个：`)
        let fuzzyNum = 0
        for (const word of banned.fuzzy) msg.push(`${++fuzzyNum}. ${word}`)
      }
    }
    
    if (globalBanned && this.group_id !== 'global') {
      let globalNum = totalNum
      
      if (globalBanned.exact.size) {
        msg.push('━━━━━━━━━━━━━━━', `【全局精确违禁词】共${globalBanned.exact.size}个：`)
        for (const word of globalBanned.exact) msg.push(`G${++globalNum - totalNum}. ${word}`)
      }
      
      if (globalBanned.images.size) {
        msg.push(`【全局图片违禁词】共${globalBanned.images.size}个：`)
        for (const [, info] of globalBanned.images) {
          msg.push(`G${++globalNum - totalNum}. ${info.desc}`)
          await AgentRuntime.fsStat(info.path) && msg.push(msgSegment.image(info.path))
        }
      }
      
      if (globalBanned.fuzzy.size) {
        msg.push('━━━━━━━━━━━━━━━', `【全局模糊违禁词】共${globalBanned.fuzzy.size}个：`)
        let globalFuzzyNum = 0
        for (const word of globalBanned.fuzzy) msg.push(`GF${++globalFuzzyNum}. ${word}`)
      }
      
      totalNum = globalNum
    }

    if (this.group_id === 'global') {
      totalNum = 0
      if (globalBanned.exact.size) {
        msg.push(`【全局精确违禁词】共${globalBanned.exact.size}个：`)
        for (const word of globalBanned.exact) msg.push(`${++totalNum}. ${word}`)
      }
      
      if (globalBanned.images.size) {
        msg.push(`【全局图片违禁词】共${globalBanned.images.size}个：`)
        for (const [, info] of globalBanned.images) {
          msg.push(`${++totalNum}. ${info.desc}`)
          await AgentRuntime.fsStat(info.path) && msg.push(msgSegment.image(info.path))
        }
      }
      
      if (globalBanned.fuzzy.size) {
        msg.push('━━━━━━━━━━━━━━━', `【全局模糊违禁词】共${globalBanned.fuzzy.size}个：`)
        let fuzzyNum = 0
        for (const word of globalBanned.fuzzy) msg.push(`${++fuzzyNum}. ${word}`)
      }
    }

    if (!totalNum && (!globalBanned || !globalBanned.exact.size && !globalBanned.fuzzy.size && !globalBanned.images.size)) {
      return this.reply("暂无违禁词")
    }

    msg.push(
      '━━━━━━━━━━━━━━━',
      '【操作提示】',
      '删除群组违禁词：#删除违禁词[序号]',
      '删除全局违禁词：#全局删除违禁词[关键词]',
      '删除模糊违禁词：#删除模糊违禁词[序号]',
      '精确违禁词：消息必须完全等于违禁词才触发',
      '模糊违禁词：消息中按顺序包含违禁词的所有字符即触发',
      '全局违禁词：对所有群生效',
      'G前缀表示全局违禁词，GF前缀表示全局模糊违禁词'
    )

    return this.reply(await AgentRuntime.makeForwardArray(msg))
  }

  /** 检查违禁词 */
  async checkBannedWords() {
    if (!this.e.isGroup) return false
    
    const groupId = this.e.group_id
    await Promise.all([this.initBannedWords(groupId), this.initBannedWords('global')])
    
    if (!bannedWordsMap[groupId]?.config?.enabled) return false

    const bwConfig = bannedWordsMap[groupId].config
    if (bwConfig.exemptRoles?.length) {
      if (this.e.isMaster) return false
      const { role } = this.getRoleInfo(this.e.user_id)
      if (bwConfig.exemptRoles.includes(role)) return false
    }
    
    let violated = false
    let violationType = ""
    let violatedWord = ""
    let isGlobal = false
    const text = (this.e.msg || this.e.raw_message || "").trim()

    // 检查文字违禁词
    if (text) {
      for (const gid of [groupId, 'global']) {
        if (!bannedWordsMap[gid]) continue
        
        // 先检查精确匹配
        for (const word of bannedWordsMap[gid].exact) {
          if (text === word) {
            violated = true
            violationType = "精确"
            violatedWord = word
            isGlobal = gid === 'global'
            break
          }
        }
        
        // 如果精确匹配未命中，检查模糊匹配
        if (!violated) {
          for (const word of bannedWordsMap[gid].fuzzy) {
            if (this.checkFuzzyMatch(text, word)) {
              violated = true
              violationType = "模糊"
              violatedWord = word
              isGlobal = gid === 'global'
              break
            }
          }
        }
        
        if (violated) break
      }
    }

    // 检查图片违禁词
    if (!violated && this.e.img?.length) {
      for (const img of this.e.img) {
        const hash = await this.getImageHash(img)
        if (!hash) continue
        
        for (const gid of [groupId, 'global']) {
          if (bannedWordsMap[gid]?.images.has(hash)) {
            violated = true
            violationType = "图片"
            violatedWord = bannedWordsMap[gid].images.get(hash).desc
            isGlobal = gid === 'global'
            break
          }
        }
        if (violated) break
      }
    }

    if (violated) {
      return await this.handleViolation(violationType, violatedWord, isGlobal)
    }
    
    return false
  }

  /** 处理违禁词触发 */
  async handleViolation(violationType, violatedWord, isGlobal = false) {
    const { group_id: groupId, user_id: userId } = this.e
    
    const userRole = this.getRoleInfo(userId)
    const botRole = this.getRoleInfo(this.e.self_id)
    
    logger.info(`[违禁词检测] 用户 ${userId}(${userRole.roleName}) 触发${isGlobal ? '全局' : '群组'}${violationType}违禁词：${violatedWord}`)
    
    await this.notifyMaster(groupId, userId, violationType, violatedWord, isGlobal, userRole)
    
    this.e.recall && await this.e.recall().catch(err => logger.warn(`撤回消息失败: ${err}`))

    const responses = this.getViolationResponse(userRole, botRole, groupId)
    const config = bannedWordsMap[groupId].config
    const warnOnly = config.warnOnly || !botRole.isAdmin
    
    if (!warnOnly && botRole.isAdmin && !userRole.isAdmin) {
      try {
        await this.e.group.muteMember(userId, config.muteTime * 60)
        await this.reply([msgSegment.at(userId), ` ${responses.mute}`])
      } catch (err) {
        logger.error(`执行禁言失败: ${err}`)
        await this.reply([msgSegment.at(userId), ` ${responses.failMute}`])
      }
    } else {
      await this.reply([msgSegment.at(userId), ` ${responses.warn}`])
    }
    
    return true
  }

  /** 通知主人违禁词触发 */
  async notifyMaster(groupId, userId, violationType, violatedWord, isGlobal, userRole) {
    try {
      if (!this.e.isGroup || !this.e.group) {
        logger.debug('非群组消息，跳过通知主人')
        return
      }
      
      const member = this.e.group.pickMember?.(userId)
      const nickname = member?.card || member?.nickname || this.e.sender?.nickname || `用户${userId}`
      const avatar = `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`
      
      const groupName = this.e.group.group_name || `群${groupId}`
      const config = bannedWordsMap[groupId]?.config || {}
      const muteTime = config.muteTime || 720
      const triggerContent = this.e.msg || this.e.raw_message || '[图片消息]'
      
      const notifyMsg = [
        `🚨 违禁词触发通知\n`,
        `━━━━━━━━━━━━━━━\n`,
        `群聊：${groupName}(${groupId})\n`,
        `触发人：${nickname}(${userId})\n`,
        `身份：${userRole.roleName}\n`,
        `违禁词类型：${isGlobal ? '全局' : '群组'}${violationType}违禁词\n`,
        `违禁词内容：${violatedWord}\n`,
        `触发内容：${triggerContent}\n`,
        `禁言时长：${muteTime}分钟\n`,
        `触发时间：${new Date().toLocaleString()}\n`,
        `━━━━━━━━━━━━━━━\n`,
        msgSegment.image(avatar)
      ]
      
      await AgentRuntime.sendMasterMsg(notifyMsg)
    } catch (err) {
      logger.error(`通知主人失败: ${err.message}`, err)
    }
  }

  /** 获取违规响应文本 */
  getViolationResponse(userRole, botRole, groupId) {
    const muteTime = bannedWordsMap[groupId]?.config?.muteTime || 720
    
    const responses = {
      botNotAdmin: {
        warn: "检测到违禁词！虽然我不是管理员不能禁言你，但还是请注意言辞哦~ (｡•́︿•̀｡)",
        mute: "",
        failMute: "想禁言你但失败了，看来我权限不够呢... ಥ_ಥ"
      },
      toOwner: {
        warn: "群主大大，您说的话包含违禁词哦！虽然不能把您怎么样，但还是请坐下冷静一下吧~ ٩(๑´3`๑)۶"
      },
      toAdmin: {
        warn: "管理员同僚，您的发言包含违禁词！大家都是管理员，请以身作则哦~ (ㆀ˘･з･˘)"
      },
      toMember: {
        warn: "检测到违禁词！请注意您的言行~ ╰(‵□′)╯",
        mute: `您发送的消息包含违禁词，已被禁言${muteTime}分钟！下次请注意哦~ (╬▔皿▔)╯`,
        failMute: "检测到违禁词，但禁言失败了... 下次注意哦！"
      }
    }

    if (!botRole.isAdmin) return responses.botNotAdmin
    if (userRole.role === 'owner') return responses.toOwner
    if (userRole.role === 'admin') return responses.toAdmin
    return responses.toMember
  }

  /** 模糊匹配检查 */
  checkFuzzyMatch(text, bannedWord) {
    const chars = bannedWord.split('')
    let lastIndex = -1
    
    for (const char of chars) {
      const index = text.indexOf(char, lastIndex + 1)
      if (index === -1) return false
      lastIndex = index
    }
    
    return true
  }

  /** 获取图片hash */
  async getImageHash(imgUrl) {
    try {
      const refs = typeof imgUrl === 'object' && imgUrl !== null ? imgUrl : { url: imgUrl }
      const buffer = await readImageBuffer(refs, this._bindSendApi(), { persist: true })
      if (!buffer?.length) return null
      return crypto.createHash('md5').update(buffer).digest('hex')
    } catch (err) {
      logger.error(`获取图片hash失败: ${err}`)
      return null
    }
  }

  /** 群号key */
  get grpKey() {
    return `AGT:group_id:${this.e.user_id}`
  }

  /** #添加 */
  async add() {
    this.isGlobal = this.e.msg.includes("全局")
    this.isFuzzy = this.e.msg.includes("模糊")
    await this.getGroupId()

    if (!this.e.msg.replace(/^#(全局)?(模糊)?添加/, "").trim() && this.e.img?.length) {
      return this.reply("请指定一个关键词来添加图片，例如：#添加表情包")
    }

    if (!this.group_id) return this.reply("请先在群内触发消息，确定添加的群")

    await this.initMessageMap()
    if (!this.checkAuth()) return false
    
    this.getKeyWord()
    if (!this.keyWord) return this.reply("添加错误：没有关键词")

    this.e._addContext = {
      keyWord: this.keyWord,
      isGlobal: this.isGlobal,
      isFuzzy: this.isFuzzy,
      group_id: this.group_id,
      messages: []
    }
    
    this.setContext("addContext", false, ADD_CONTEXT_TIMEOUT)
    const groupType = this.isGlobal ? '全局' : '群组'
    const matchType = this.isFuzzy ? '模糊' : '精确'
    return this.reply(`请发送添加内容（支持文字、图片、聊天记录），完成后发送#结束添加\n当前添加：${groupType}${matchType}词条【${this.keyWord}】`, true, { at: true })
  }

  /** 获取群号 */
  async getGroupId() {
    if (this.isGlobal) {
      this.group_id = "global"
      return
    }

    if (this.e.isGroup) {
      this.group_id = this.e.group_id
      // 缓存群号到Redis（30天）
      redis.setEx(this.grpKey, 2592000, String(this.group_id))
      return
    }

    // 从Redis获取缓存的群号
    this.group_id = await redis.get(this.grpKey)
  }

  /** 权限检查 */
  checkAuth() {
    if (this.e.isMaster) return true
    
    // 全局操作需要主人权限
    if (this.isGlobal) {
      this.reply("暂无权限，只有主人才能操作")
      return false
    }

    const groupCfg = runtimeConfig.getGroup(this.group_id) || {}
    
    // addLimit: 2 = 仅主人, 1 = 管理员, 0 = 所有人
    if (groupCfg.addLimit === 2) {
      this.reply("暂无权限，只有主人才能操作")
      return false
    }
    
    if (groupCfg.addLimit === 1 && !this.e.member?.is_admin) {
      this.reply("暂无权限，只有管理员才能操作")
      return false
    }

    // 私聊添加限制
    if (groupCfg.addPrivate !== 1 && !this.e.isGroup) {
      this.reply("禁止私聊添加")
      return false
    }

    return true
  }

  /** 获取添加关键词 */
  getKeyWord() {
    const msg = this.e.msg || this.e.raw_message || ""
    this.keyWord = this.trimAlias(msg.replace(/^#(全局)?(模糊)?(添加|删除)/, "").trim())
  }

  /** 过滤别名 */
  trimAlias(msg) {
    if (!msg) return msg
    
    const groupCfg = runtimeConfig.getGroup(this.group_id) || {}
    const alias = groupCfg.botAlias
    if (!alias) return msg
    
    const aliasList = Array.isArray(alias) ? alias : [alias]
    for (const name of aliasList) {
      if (msg.startsWith(name)) {
        msg = lodash.trimStart(msg, name).trim()
        break
      }
    }
    
    return msg
  }

  /** 添加内容 */
  async addContext() {
    const context = this.getContext("addContext")
    if (!context?._addContext) return false
    
    const contextData = context._addContext
    Object.assign(this, {
      isGlobal: contextData.isGlobal,
      isFuzzy: contextData.isFuzzy,
      group_id: contextData.group_id,
      keyWord: contextData.keyWord
    })
    
    await this.initMessageMap()

    if (this.e.msg?.includes("#结束添加")) {
      this.finish("addContext")
      
      if (!contextData.messages?.length) return this.reply("添加错误：没有添加内容")

      messageMap[this.group_id] || (messageMap[this.group_id] = new Map())
      
      const storageKey = this.isFuzzy ? `[模糊]${this.keyWord}` : this.keyWord
      let messages = messageMap[this.group_id].get(storageKey) || []
      messages = messages.concat(contextData.messages)
      messageMap[this.group_id].set(storageKey, messages)
      
      await this.saveJson()
      
      const groupType = this.isGlobal ? '全局' : '群组'
      const matchType = this.isFuzzy ? '模糊' : '精确'
      
      await this.reply([
        `✅ 添加成功！`,
        `类型：${groupType}${matchType}词条`,
        `关键词：${this.keyWord}`,
        `总回复数：${messages.length}`,
        `本次添加：${contextData.messages.length} 条回复`
      ].join('\n'))
      
      return true
    }

    let currentMessage
    try {
      const segs = this.e.message || []
      const heavy = segs.some(
        (s) => s && ['image', 'file', 'forward', 'video', 'record'].includes(s.type)
      )
      // 图片/转发需下载落盘，先回一句避免「卡住」感
      if (heavy) await this.reply('收到，正在保存…')
      currentMessage = await this.transformSegments(segs, 'store', { root: true })
    } catch (err) {
      logger.error(`添加词条内容失败: ${err.message}`, err)
      return this.reply(`添加失败：${err.message || '无法解析该消息（聊天记录可能已过期）'}`)
    }

    if (!currentMessage.length) {
      return this.reply('未能解析消息内容，请重新发送（聊天记录请直接转发给 AgentRuntime）')
    }

    contextData.messages.push(currentMessage)

    this.e._addContext = contextData
    this.setContext("addContext", false, ADD_CONTEXT_TIMEOUT)
    
    const groupType = contextData.isGlobal ? '全局' : '群组'
    const matchType = contextData.isFuzzy ? '模糊' : '精确'
    const status = [
      `继续发送要添加的内容，或发送#结束添加`,
      `当前添加：${groupType}${matchType}词条【${contextData.keyWord}】`
    ]
    contextData.messages.length && status.push(`已添加 ${contextData.messages.length} 条回复`)
    
    return this.reply(status.join('\n'))
  }

  /** 保存JSON */
  async saveJson() {
    if (!this.group_id || !messageMap[this.group_id]) return
    
    try {
      const obj = Object.fromEntries(messageMap[this.group_id])
      await fs.writeFile(`${messageDataPath}${this.group_id}.json`, JSON.stringify(obj, null, 2), 'utf8')
    } catch (err) {
      logger.error(`保存JSON失败 ${this.group_id}: ${err.message}`, err)
    }
  }

  _bindSendApi() {
    if (!this.e?.bot?.sendApi) return undefined
    return (action, params) => this.e.bot.sendApi(action, params)
  }

  /** 词条媒体是否已落盘到 messageDataPath（相对路径 group/type/file） */
  async isEntryMediaPersisted(item) {
    const fileRef = String(item?.file ?? '').trim()
    if (!isEntryMediaRelPath(fileRef)) return false
    return AgentRuntime.fsStat(`${messageDataPath}${fileRef}`)
  }

  /** 词条媒体是否仍需本地化（未写入 messageDataPath 的 HTTP / NapCat 临时引用） */
  async needsMediaLocalization(item) {
    if (!ENTRY_MEDIA_TYPES.has(item.type)) return false
    const fileRef = String(item.file ?? '').trim()
    const urlRef = String(item.url ?? '').trim()
    if (!fileRef && !urlRef) return false
    if (fileRef.startsWith('base64://')) return false
    if (await this.isEntryMediaPersisted(item)) return false
    return true
  }

  /** 保存文件到 messageDataPath，返回相对路径；失败返回 null（不存 URL） */
  async saveFile(data) {
    try {
      const rel = await persistEntryMedia(data, {
        baseDir: messageDataPath,
        groupId: this.group_id,
        sendApi: this._bindSendApi(),
      })
      if (!rel) {
        const hint = String(data.file ?? data.url ?? '').slice(0, 80)
        logger.error(`保存文件失败: 无法下载媒体 ${hint}`)
      }
      return rel
    } catch (err) {
      logger.error(`保存文件失败: ${err.message}`, err)
      return null
    }
  }

  /** 获取 getForwardMsg（兼容群/私聊/事件直挂） */
  getForwardGetter() {
    return this.e.group?.getForwardMsg || this.e.friend?.getForwardMsg || this.e.getForwardMsg
  }

  /** 拉取并规范化转发节点（底层 adapter 负责嵌套展开，此处做媒体本地化） */
  async fetchForwardNodes(seg, root = false) {
    const getter = this.getForwardGetter()
    if (!getter) throw new Error('当前环境不支持获取聊天记录')

    const ids = collectForwardIds(seg, root ? this.e.message_id : null)
    if (!ids.length) throw new Error('聊天记录 ID 无效')

    let nodes
    let lastErr
    try {
      nodes = await getter(ids[0], 0, ids.slice(1))
    } catch (err) {
      lastErr = err
      nodes = undefined
    }
    if (!Array.isArray(nodes) || !nodes.length) {
      for (const id of ids) {
        try {
          nodes = await getter(id)
          if (Array.isArray(nodes) && nodes.length) break
        } catch (err) {
          lastErr = err
        }
      }
    }
    if (!Array.isArray(nodes) || !nodes.length) {
      throw lastErr || new Error('聊天记录为空或已过期')
    }

    return Promise.all(nodes.map(async node => ({
      ...normalizeNodeMeta(node),
      message: await this.transformSegments(getNodeMessages(node), 'store', { root: false })
    })))
  }

  /**
   * 统一消息段变换：store=添加存储（展开 forward、本地化媒体），send=发送前解析路径
   */
  async transformSegments(segments, mode = 'store', { root = false } = {}) {
    if (!Array.isArray(segments)) return []
    const out = []

    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue
      if (mode === 'store' && seg.type === 'at' && seg.qq == this.e.self_id) continue

      if (seg.type === 'forward') {
        if (mode === 'send') logger.warn('[词条] 检测到未展开的 forward，尝试补救')
        try {
          const nodes = await this.fetchForwardNodes(seg, root)
          if (nodes.length) out.push({ type: 'node', data: nodes })
        } catch (err) {
          if (mode === 'store') throw err
          logger.error(`[词条] forward 补救失败: ${err.message}`)
        }
        continue
      }

      if (seg.type === 'node' && Array.isArray(seg.data)) {
        const data = []
        for (const node of seg.data) {
          data.push({
            ...normalizeNodeMeta(node),
            message: await this.transformSegments(getNodeMessages(node), mode, { root: false })
          })
        }
        if (data.length) out.push({ type: 'node', data })
        continue
      }

      const item = { ...seg }
      if (mode === 'store' && await this.needsMediaLocalization(item)) {
        const saved = await this.saveFile(item)
        if (!saved) throw new Error(`${item.type} 本地化失败，请重新发送`)
        item.file = saved
        delete item.url
        delete item.fid
      } else if (mode === 'send' && ENTRY_MEDIA_TYPES.has(item.type)) {
        const inline = inlineBinaryFromRef(item.file)
        if (inline) {
          item.file = `base64://${inline.toString('base64')}`
          delete item.url
          delete item.fid
        } else {
          const localPath = await this.resolveEntryMediaPath(item)
          if (!localPath) continue
          item.file = localPath
          delete item.url
          delete item.fid
        }
      }
      out.push(item)
    }
    return out
  }

  /** 解析词条存储的媒体本地路径（仅相对/绝对本地路径，不含 HTTP / 内联二进制） */
  async resolveEntryMediaPath(item) {
    const ref = String(item?.file ?? '').trim()
    if (!ref || isHttpRef(ref) || ref.startsWith('base64://') || inlineBinaryFromRef(ref)) return null
    if (isEntryMediaRelPath(ref)) {
      const localPath = `${messageDataPath}${ref}`
      if (await AgentRuntime.fsStat(localPath)) return localPath
    }
    if (isPathLike(ref)) {
      if (await AgentRuntime.fsStat(ref)) return ref
      const nested = `${messageDataPath}${ref}`
      if (await AgentRuntime.fsStat(nested)) return nested
    }
    if (!ref.includes('/')) return ref
    return null
  }

  /** 获取关键词消息 */
  getKeyWordMsg(keyWord) {
    if (!keyWord) return []
    
    // 先查找精确匹配
    const exactMessages = [
      ...(messageMap[this.group_id]?.get(keyWord) || []),
      ...(messageMap.global?.get(keyWord) || [])
    ]
    
    if (exactMessages.length) return exactMessages

    // 再查找模糊匹配
    const fuzzyMessages = []
    const allEntries = [
      ...(messageMap[this.group_id]?.entries() || []),
      ...(messageMap.global?.entries() || [])
    ]
    
    for (const [key, messages] of allEntries) {
      if (key.startsWith('[模糊]')) {
        const fuzzyKey = key.substring(4)
        if (this.checkFuzzyMatch(keyWord, fuzzyKey)) {
          fuzzyMessages.push(...messages)
        }
      }
    }
    
    return fuzzyMessages
  }

  /** 获取消息 */
  async getMessage() {
    if (!this.e.msg && !this.e.raw_message) return false
    
    if (await this.checkBannedWords()) return true
    
    this.isGlobal = false
    await this.getGroupId()
    if (!this.group_id) return false

    await Promise.all([this.initMessageMap(), this.initGlobalMessageMap()])

    this.keyWord = this.trimAlias((this.e.msg || this.e.raw_message || "").trim())

    let messages = this.getKeyWordMsg(this.keyWord)
    if (!messages.length) {
      const match = this.keyWord.match(/^(.+?)(\d+)$/)
      if (match) {
        const [, baseKey, index] = match
        const allMsg = this.getKeyWordMsg(baseKey)
        const idx = parseInt(index) - 1
        if (allMsg[idx]) {
          messages = [allMsg[idx]]
          this.keyWord = `${baseKey}(${index})`
        }
      }
    }
    
    if (!messages.length) return false

    const msg = messages[lodash.random(0, messages.length - 1)]
    if (lodash.isEmpty(msg)) return false

    const msgToSend = await this.transformSegments([...msg], 'send')
    if (!msgToSend.length) {
      logger.error(`[发送消息] 词条【${this.keyWord}】内容无法发送`)
      return this.reply('该词条内容无法发送（聊天记录引用可能已失效），请删除后重新添加')
    }

    logger.mark(`[发送消息]${this.e.logText}[${this.keyWord}]`)
    const groupCfg = runtimeConfig.getGroup(this.group_id)
    return this.reply(msgToSend, Boolean(groupCfg.addReply), {
      at: Boolean(groupCfg.addAt),
      recallMsg: groupCfg.addRecall
    })
  }

  /** 初始化已添加内容 */
  async initMessageMap() {
    if (messageMap[this.group_id]) return
    messageMap[this.group_id] = new Map()

    const filePath = `${messageDataPath}${this.group_id}.json`
    if (!await AgentRuntime.fsStat(filePath)) return

    try {
      const message = JSON.parse(await fs.readFile(filePath, "utf8"))
      for (const key in message) {
        messageMap[this.group_id].set(key, message[key])
      }
    } catch (err) {
      logger.error(`JSON 格式错误：${filePath} - ${err.message}`, err)
    }
  }

  /** 初始化全局已添加内容 */
  async initGlobalMessageMap() {
    if (messageMap.global) return
    messageMap.global = new Map()

    const globalPath = `${messageDataPath}global.json`
    if (!await AgentRuntime.fsStat(globalPath)) return

    try {
      const message = JSON.parse(await fs.readFile(globalPath, "utf8"))
      for (const key in message) {
        messageMap.global.set(key, message[key])
      }
    } catch (err) {
      logger.error(`JSON 格式错误：${globalPath} - ${err.message}`, err)
    }
  }

  /** 删除文件 */
  async delFile(messages) {
    if (!Array.isArray(messages)) return

    const files = []
    for (const msg of Array.isArray(messages[0]) ? messages : [messages]) {
      collectSegmentFiles(Array.isArray(msg) ? msg : [msg], files)
    }

    return Promise.allSettled(files.map(file => fs.rm(`${messageDataPath}${file}`).catch(() => {})))
  }

  /** #删除 */
  async del() {
    this.isGlobal = this.e.msg.includes("全局")
    this.isFuzzy = this.e.msg.includes("模糊")
    await this.getGroupId()
    if (!this.group_id || !this.checkAuth()) return false

    await this.initMessageMap()

    const param = this.e.msg.match(/^#(全局)?(模糊)?删除(.*)/)?.[3]?.trim()
    if (!param) return this.reply("删除错误：没有关键词或序号")

    const num = parseInt(param)
    if (!isNaN(num) && num > 0) {
      const allKeys = Array.from(messageMap[this.group_id].keys()).filter(key => 
        this.isFuzzy ? key.startsWith('[模糊]') : !key.startsWith('[模糊]')
      )
      if (num <= allKeys.length) {
        const keyToDelete = allKeys[num - 1]
        const messages = messageMap[this.group_id].get(keyToDelete)
        await this.delFile(messages)
        messageMap[this.group_id].delete(keyToDelete)
        await this.saveJson()
        const displayKey = keyToDelete.startsWith('[模糊]') ? keyToDelete.substring(4) : keyToDelete
        const groupType = this.isGlobal ? '全局' : '群组'
        const matchType = this.isFuzzy ? '模糊' : '精确'
        await this.reply(`✅ 删除成功：${groupType}${matchType}词条【${displayKey}】`)
        
        const savedMsg = this.e.msg
        this.e.msg = "#词条列表"
        await this.list()
        this.e.msg = savedMsg
        return true
      }
    }

    this.keyWord = this.trimAlias(param)
    const storageKey = this.isFuzzy ? `[模糊]${this.keyWord}` : this.keyWord
    
    if (messageMap[this.group_id].has(storageKey)) {
      const messages = messageMap[this.group_id].get(storageKey)
      await this.delFile(messages)
      messageMap[this.group_id].delete(storageKey)
      await this.saveJson()
      const groupType = this.isGlobal ? '全局' : '群组'
      const matchType = this.isFuzzy ? '模糊' : '精确'
      await this.reply(`✅ 删除成功：${groupType}${matchType}词条【${this.keyWord}】`)
      
      const savedMsg = this.e.msg
      this.e.msg = "#词条列表"
      await this.list()
      this.e.msg = savedMsg
      return true
    }
    
    const indexMatch = this.keyWord.match(/^(.+?)(\d+)$/)
    if (indexMatch) {
      const [, baseKey, index] = indexMatch
      const storageKey = this.isFuzzy ? `[模糊]${baseKey}` : baseKey
      const messages = messageMap[this.group_id].get(storageKey)
      const idx = parseInt(index) - 1
      if (messages?.[idx]) {
        await this.delFile([messages[idx]])
        messages.splice(idx, 1)
        messages.length || messageMap[this.group_id].delete(storageKey)
        await this.saveJson()
        await this.reply(`✅ 删除成功：${baseKey}(${index})`)
        
        const savedMsg = this.e.msg
        this.e.msg = "#词条列表"
        await this.list()
        this.e.msg = savedMsg
        return true
      }
    }
    
    const groupType = this.isGlobal ? '全局' : '群组'
    const matchType = this.isFuzzy ? '模糊' : '精确'
    return this.reply(`❌ 删除错误：没有找到该${groupType}${matchType}词条`)
  }

  /** 将词条回复内容转为转发消息（图片/视频/语音显示真实媒体） */
  async buildEntryPreview(content, prefix = '') {
    const parts = []
    if (prefix) parts.push(prefix)

    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      switch (item.type) {
        case 'text': {
          const text = item.text || ''
          const preview = text.length > 30 ? `${text.substring(0, 30)}...` : text
          if (preview) parts.push(preview)
          break
        }
        case 'image':
        case 'video':
        case 'record': {
          const filePath = await this.resolveEntryMediaPath(item)
          if (filePath) {
            if (item.type === 'image') parts.push(msgSegment.image(filePath))
            else if (item.type === 'video') parts.push(msgSegment.video(filePath))
            else parts.push(msgSegment.record(filePath))
          } else {
            const labels = { image: '[图片]', video: '[视频]', record: '[语音]' }
            parts.push(labels[item.type] || `[${item.type}]`)
          }
          break
        }
        case 'face':
          parts.push(`[表情:${item.id ?? item.data?.id ?? ''}]`)
          break
        case 'node': {
          const nodes = Array.isArray(item.data) ? item.data : []
          if (!nodes.length) break
          const hasNested = nodes.some(n => getNodeMessages(n).some(s => s?.type === 'node' || s?.type === 'forward'))
          const summary = nodes.slice(0, 2).map(n => {
            const text = getNodeMessages(n).filter(s => s.type === 'text').map(s => s.text || '').join('').slice(0, 15)
            return `${n.nickname || '匿名'}:${text || '...'}`
          }).join(' | ')
          parts.push(`[聊天记录${nodes.length}条${hasNested ? '(含嵌套)' : ''}${summary ? ` ${summary}` : ''}]`)
          break
        }
        case 'forward':
          parts.push('[聊天记录(未展开)]')
          break
        default:
          parts.push(`[${item.type}]`)
      }
    }

    if (!parts.length) return null
    if (parts.length === 1 && typeof parts[0] === 'string') return parts[0]
    return parts
  }

  /** 消息列表 */
  async list() {
    this.isGlobal = this.e.msg.includes("全局")

    let page = 1
    const pageSize = 50
    let type = "list"

    await this.getGroupId()
    if (!this.group_id) return false

    await this.initMessageMap()

    let search = this.e.msg.replace(/^#(全局)?(消息|词条)/, "").trim()
    
    if (search === "列表") search = ""
    
    if (search.match(/^列表/)) {
      page = parseInt(search.replace(/^列表/, "")) || 1
    } else if (search && !search.includes("列表")) {
      type = "search"
    }

    const list = messageMap[this.group_id]
    if (!list?.size) return this.reply("暂无消息")

    const entries = []
    let num = 0
    
    for (const [k, v] of list) {
      const displayKey = k.startsWith('[模糊]') ? k.substring(4) + '(模糊)' : k
      if (type === "search" && !displayKey.includes(search)) continue
      entries.push({ key: displayKey, originalKey: k, val: v, num: ++num })
    }

    const count = entries.length
    if (!count) return this.reply(type === "search" ? `未找到包含"${search}"的消息` : "暂无消息")

    entries.reverse()

    const displayEntries = type === "list" ? this.pagination(page, pageSize, entries) : entries

    const msg = []
    const title = type === "search" 
      ? `【消息搜索】"${search}"，共${count}条`
      : `【消息列表】第${page}页，共${count}条`
    
    msg.push(title, '━━━━━━━━━━━━━━━')

    for (const entry of displayEntries) {
      msg.push(`${entry.num}. ${entry.key}${entry.val.length > 1 ? `(${entry.val.length}条回复)` : ''}`)
      
      for (let i = 0; i < entry.val.length && i < 3; i++) {
        const content = entry.val[i]
        if (Array.isArray(content)) {
          const prefix = entry.val.length > 1 ? `   └─ 回复${i + 1}: ` : `   └─ `
          const previewMsg = await this.buildEntryPreview(content, prefix)
          if (previewMsg) msg.push(previewMsg)
        }
      }
      
      if (entry.val.length > 3) {
        msg.push(`   └─ ...还有 ${entry.val.length - 3} 条回复`)
      }
    }

    msg.push(
      '━━━━━━━━━━━━━━━',
      '【操作提示】',
      '删除词条：#删除[序号/关键词]',
      '删除模糊词条：#模糊删除[序号/关键词]',
      '添加词条：#添加[关键词]',
      '添加模糊词条：#模糊添加[关键词]',
      '搜索词条：#词条[关键词]'
    )
    
    if (type === "list" && count > pageSize) {
      const totalPages = Math.ceil(count / pageSize)
      msg.push(
        '━━━━━━━━━━━━━━━',
        `当前第${page}/${totalPages}页`
      )
      page < totalPages && msg.push(`查看下一页：#词条列表${page + 1}`)
      page > 1 && msg.push(`查看上一页：#词条列表${page - 1}`)
    }

    return this.reply(await AgentRuntime.makeForwardArray(msg))
  }

  /** 分页 */
  pagination(pageNo, pageSize, array) {
    const offset = (pageNo - 1) * pageSize
    return array.slice(offset, offset + pageSize)
  }
}