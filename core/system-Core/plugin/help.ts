// @ts-nocheck
export class Help extends PluginBase {
  constructor() {
    super({
      name: '帮助',
      dsc: '#帮助',
      event: 'message',
      priority: 4000,
      rule: [{ reg: '^#帮助$', fnc: 'help' }]
    })
  }

  async help() {
    const data = {
      saveId: `help_${Date.now()}`,
      imgType: 'png',
      quality: 100,
      sys: { scale: 3 },
      title: 'XRK-AGT',
      subtitle: '#帮助',
      sections: [
        {
          name: '常用',
          items: [
            { cmd: '#状态', desc: '运行状态' },
            { cmd: '#更新', desc: '更新指定/根仓' },
            { cmd: '#重启', desc: '热重启 · 主人' },
            { cmd: '#热关机', desc: '停消息，可 #开机 · 主人' },
            { cmd: '#关机', desc: '退出进程 · 主人' },
            { cmd: '#开机', desc: '解除热关机 · 主人' },
            { cmd: '#点歌', desc: '#点歌 歌名' },
            { cmd: '#复读', desc: '主动复读' },
          ]
        },
        {
          name: '更新',
          items: [
            { cmd: '#强制更新', desc: '单仓 fetch + reset --hard @{upstream} · 主人' },
            { cmd: '#全部更新', desc: 'core/* + 根仓 · 主人' },
            { cmd: '#全部强制更新', desc: '冲突才强制 · 主人' },
            { cmd: '#静默全部更新', desc: '有变更才回汇总 · 主人' },
            { cmd: '#查看日志', desc: 'git 更新日志' },
            { cmd: '#日志', desc: '#日志 / #日志错误 / #日志追踪' },
          ]
        },
        {
          name: '词条',
          items: [
            { cmd: '#添加', desc: '#添加 / #删除' },
            { cmd: '#消息', desc: '#消息 / #词条 列表' },
            { cmd: '#违禁词', desc: '增删列开关' },
            { cmd: '#清空违禁词', desc: '清空 · 主人' },
          ]
        },
        {
          name: '终端',
          items: [
            { cmd: 'rx', desc: '项目目录 shell' },
            { cmd: 'rh', desc: '用户目录 shell' },
            { cmd: 'roj', desc: '跑 JS' },
            { cmd: 'roi', desc: '查对象' },
            { cmd: 'rj', desc: '表达式' },
            { cmd: 'rrl', desc: '历史' },
            { cmd: 'rc', desc: '配置' },
          ]
        },
        {
          name: '子服终端',
          items: [
            { cmd: '帮助', desc: '已装插件组' },
            { cmd: '<组> 状态', desc: '如 media-tools 状态' },
            { cmd: '<组> 更新', desc: '如 web-fetch 更新' },
            { cmd: '退出', desc: '关 REPL，HTTP 仍在' },
          ]
        },
        {
          name: '设备 / Web',
          items: [
            { cmd: 'Event', desc: '走事件链（戳一戳 / 发消息）' },
            { cmd: 'AI', desc: '工作流对话' },
          ]
        }
      ],
      footer: 'XRK-AGT'
    }
    try {
      const result = await this.e.runtime.render('帮助', 'help', data, { retType: 'base64' })
      await this.reply(result || '帮助页生成失败')
    } catch (err) {
      logger.error(`[帮助] 渲染失败: ${err.message}`)
      await this.reply(`帮助页失败: ${err.message}`)
    }
    return true
  }
}
