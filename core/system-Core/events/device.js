import ListenerBase from '#infrastructure/listener/base.js'

export default class DeviceEvent extends ListenerBase {
  constructor() {
    super('device')
  }

  async init() {
    const bot = this.bot || AgentRuntime
    for (const t of ['message', 'notice', 'request']) {
      bot.on(`device.${t}`, (e) => this.handleEvent(e))
    }
  }

  async handleEvent(e) {
    if (!e) return
    this.ensureEventId(e)
    if (!this.markProcessed(e)) return
    this.markTasker(e, { isDevice: true })
    if (e.device_type === 'web' || e.isMaster === true) e.isMaster = true
    await this.plugins.deal(e)
  }
}

