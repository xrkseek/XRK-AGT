import { EXIT_RESTART, EXIT_STOP } from '#utils/process-signals.js'
import { resolveTaskerId } from '#utils/event-keys.js'
import PluginBase from '#infrastructure/plugins/plugin-base.js';

const gLogger = (): any => (globalThis as any).logger;
const gAgentRuntime = (): any => (globalThis as any).AgentRuntime;
const gRedis = (): any => (globalThis as any).redis;

const RESTART_KEY = 'AGT:restart'
const SHUTDOWN_KEY = 'AGT:shutdown'

export class Restart extends PluginBase {
  [key: string]: any;
  static _ackDone: any = false;
  constructor(e: any = '') {
    super({
      name: '重启与关机',
      dsc: '#重启 #热关机 #停机 #关机 #开机',
      event: 'message',
      priority: 10,
      rule: [
        { reg: '^#重启$', fnc: 'restart', permission: 'master' },
        { reg: '^#(热关机|停机)$', fnc: 'hotStop', permission: 'master' },
        { reg: '^#关机$', fnc: 'powerOff', permission: 'master' },
        { reg: '^#开机$', fnc: 'start', permission: 'master' },
      ],
    })
    e && (this.e = e)
  }

  async init() {
    if (Restart._ackDone) return
    Restart._ackDone = true
    const ack = (uid: any) => uid && Restart._sendRestartAck(uid)
    gAgentRuntime().on('device.online', (d: any) => ack(d?.device_id))
    gAgentRuntime().on('ready', (d: any) => ack(d?.self_id ?? d?.uin))
    setTimeout(() => (gAgentRuntime().uin || []).forEach((ack: any) => ack), 5000)
    gLogger()?.mark('[重启] 已注册重连/就绪回复耗时')
  }

  /** 单次 MULTI：GET+DEL 原子，避免 ready / device.online 并发双读 */
  static async _popRestartPayload(uid: any) {
    const key = `${RESTART_KEY}:${uid}`
    const replies = await gRedis()?.multi().get(key).del(key).exec().catch(() => null)
    return replies?.[0] ?? null
  }

  static async _sendRestartAck(uid: any) {
    if (!uid || !gRedis()) return
    try {
      const raw = await Restart._popRestartPayload(uid)
      if (!raw) return
      const d = JSON.parse(raw)
      const msg = `重启完成，耗时 ${((Date.now() - (d.time || 0)) / 1000).toFixed(1)} 秒`
      const bot = gAgentRuntime()[uid]
      let sent = false
      if (bot?.reply) {
        sent = await bot.reply(msg).then(() => true).catch(() => false)
      } else if (bot?.sendMsg && (d.tasker === 'device' || !d.id)) {
        sent = await bot.sendMsg(msg).then(() => true).catch(() => false)
      } else if (d.tasker === 'onebot' && d.id && (d.isGroup ? gAgentRuntime().sendGroupMsg : gAgentRuntime().sendFriendMsg)) {
        if (d.isGroup) await gAgentRuntime().sendGroupMsg(d.uin, d.id, msg)
        else await gAgentRuntime().sendFriendMsg(d.uin, d.id, msg)
        sent = true
      }
      if (sent) gLogger()?.mark(`[重启] 已向 ${uid} 回复耗时`)
    } catch (err: any) {
      gLogger()?.error(`[重启] 回复耗时失败 ${uid}: ${err.message}`, err)
    }
  }

  _uin() {
    return this.e?.self_id || this.e?.bot?.uin || gAgentRuntime().uin?.[0]
  }

  async restart() {
    const uin = this._uin()
    await this.e.reply('开始执行重启，请稍等...')
    await gRedis()?.set(`${RESTART_KEY}:${uin}`, JSON.stringify({
      uin,
      tasker: resolveTaskerId(this.e) || (this.e.device_id ? 'device' : 'onebot'),
      isGroup: !!this.e.isGroup,
      id: this.e.isGroup ? this.e.group_id : this.e.user_id,
      time: Date.now(),
      user_id: this.e.user_id,
    }), { EX: 300 })
    gLogger()?.mark(`[重启] 保存重启信息到 ${RESTART_KEY}:${uin}`)
    setTimeout(() => process.exit(EXIT_RESTART), 1000)
    return true
  }

  /** Redis 标记停机：进程仍在，仅忽略消息；`#开机` 恢复 */
  async hotStop() {
    const uin = this._uin()
    await gRedis()?.set(`${SHUTDOWN_KEY}:${uin}`, 'true')
    await this.e.reply('热关机成功，已停止处理消息。发送"#开机"可恢复运行')
    gLogger()?.mark(`[热关机][${uin}] 机器人已热关机`)
    return true
  }

  /** 真关机：子进程 exit(0)，菜单守护回菜单 */
  async powerOff() {
    await this.e.reply('正在关机，返回菜单…')
    gLogger()?.mark('[关机] 进程退出，返回菜单')
    setTimeout(() => process.exit(EXIT_STOP), 1000)
    return true
  }

  async start() {
    const uin = this._uin()
    if ((await gRedis()?.get(`${SHUTDOWN_KEY}:${uin}`)) !== 'true') {
      await this.e.reply('机器人已经处于开机状态')
      return false
    }
    await gRedis()?.del(`${SHUTDOWN_KEY}:${uin}`)
    await this.e.reply('开机成功，恢复正常运行')
    gLogger()?.mark(`[开机][${uin}] 机器人已开机`)
    return true
  }
}
