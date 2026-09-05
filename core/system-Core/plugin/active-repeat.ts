// @ts-nocheck
/**
 * 主动复读插件
 * 复读用户发送的内容，然后撤回
 */
export class example2 extends PluginBase {
  constructor() {
    super({
      name: '复读',
      dsc: '复读用户发送的内容，然后撤回',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#复读$',
          fnc: 'repeat'
        }
      ]
    })
  }

  /** 复读 */
  async repeat() {
    // 设置上下文，后续接收到内容会执行doRep方法
    this.setContext('doRep')
    // 回复提示
    await this.reply('请发送要复读的内容', false, { at: true })
    return true
  }

  /** 接受内容并复读 */  
  async doRep() {
    if (!this.e.message) {
      await this.reply('未收到内容，复读已取消')
      this.finish('doRep')
      return false
    }
    
    // 复读内容，5秒后撤回
    await this.reply(this.e.message, false, { recallMsg: 5 })
    // 结束上下文
    this.finish('doRep')
    return true
  }
}
