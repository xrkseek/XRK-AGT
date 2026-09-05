import PluginLoader from '#infrastructure/plugins/loader.js'
import { EventNormalizer } from '#utils/event-normalizer.js'
import PluginBase from '#infrastructure/plugins/plugin-base.js';

const gLogger = (): any => (globalThis as any).logger;
const gAgentRuntime = (): any => (globalThis as any).AgentRuntime;

/**
 * 模拟定时输入插件
 * 用于定时模拟用户输入消息
 */
export class DailySignIn extends PluginBase {
  [key: string]: any;
  constructor() {
    super({
      name: '每日定时消息模拟',
      dsc: '每天12点模拟发送消息',
      event: 'onebot.message',
      priority: 5,
      rule: []
    })
  }

  async init() {
    this.task = {
      name: '每日12点模拟消息发送',
      cron: '0 0 12 * * *',
      fnc: () => this.sendDailyMessages(),
      log: false
    } as any
  }

  /**
   * 发送每日消息
   */
  async sendDailyMessages() {
    const messages = ['#你是谁']
    for (const msg of messages) {
      const fakeMsgEvent = this.createMessageEvent(msg)
      await PluginLoader.deal(fakeMsgEvent)
    }
  }

  /**
   * 创建模拟消息事件
   * @param {string} inputMsg - 输入消息
   * @returns {Object} 事件对象
   */
  createMessageEvent(inputMsg: any) {
    const user_id = 12345678
    const name = "模拟用户"
    const time = Math.floor(Date.now() / 1000)
    const self_id = gAgentRuntime().uin.toString()

    const event = {
      tasker: "stdin",
      message_id: `test_${Date.now()}`,
      message_type: "private",
      post_type: "message",
      sub_type: "friend",
      self_id,
      time,
      user_id,
      message: [{ type: "text", text: inputMsg }],
      raw_message: inputMsg,
      isMaster: true,
      isStdin: true,
      bot: gAgentRuntime().stdin || gAgentRuntime()[gAgentRuntime().uin.toString()],
      sender: {
        card: name,
        nickname: name,
        role: "master",
        user_id
      },
      reply: async (replyMsg: any) => {
        gLogger()?.info(`模拟回复：${JSON.stringify(replyMsg)}`)
        return { message_id: `test_${Date.now()}`, time }
      }
    }

    // 使用 EventNormalizer 标准化事件
    EventNormalizer.normalizeStdin(event)
    EventNormalizer.normalizeMessage(event)

    return event
  }
}