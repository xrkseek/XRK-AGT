import ListenerBase from '#infrastructure/listener/base.js'

const gAgentRuntime = (): any => (globalThis as any).AgentRuntime;

export default class DeviceEvent extends ListenerBase {
  [key: string]: any;
  constructor() {
    super('device')
  }

  async init() {
    const bot = this.bot || gAgentRuntime()
    for (const t of ['message', 'notice', 'request']) {
      bot.on(`device.${t}`, (e: any) => this.handleEvent(e))
    }
  }

  async handleEvent(e: any) {
    if (!e) return
    this.ensureEventId(e)
    if (!this.markProcessed(e)) return
    this.markTasker(e, { isDevice: true })
    if (e.device_type === 'web' || e.isMaster === true) e.isMaster = true
    await this.plugins.deal(e)
  }
}

