import ListenerBase from '#infrastructure/listener/base.js'

export default class StdinEvent extends ListenerBase {
  constructor() {
    super('stdin')
  }

  async init() {
    const bot = this.bot || AgentRuntime
    bot.on('stdin.message', (e) => this.handleEvent(e))
  }

  async handleEvent(e) {
    if (!e) return
    this.ensureEventId(e)
    if (!this.markProcessed(e)) return
    this.markTasker(e, { isStdin: true })
    e.isMaster = true
    await this.plugins.deal(e)
  }
}

