import ListenerBase from '#infrastructure/listener/base.js'

const gAgentRuntime = (): any => (globalThis as any).AgentRuntime;

export default class StdinEvent extends ListenerBase {
  [key: string]: any;
  constructor() {
    super('stdin')
  }

  async init() {
    const bot = this.bot || gAgentRuntime()
    bot.on('stdin.message', (e: any) => this.handleEvent(e))
  }

  async handleEvent(e: any) {
    if (!e) return
    this.ensureEventId(e)
    if (!this.markProcessed(e)) return
    this.markTasker(e, { isStdin: true })
    e.isMaster = true
    await this.plugins.deal(e)
  }
}

