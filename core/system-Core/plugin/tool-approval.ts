// @ts-nocheck
import {
  resolveToolApproval,
  listPendingApprovals,
  parseApprovalCommand,
  isToolApprovalEnabled
} from '#utils/security/tool-approval.js'

/**
 * 主人审批危险工具。默认关闭（security.approval.enabled=false）。
 * 命令：#批准 / #批准id / #批准 id（空格可选）；拒绝同理。
 */
export class ToolApproval extends PluginBase {
  constructor() {
    super({
      name: '工具审批',
      dsc: '#批准 #拒绝 #待审批（危险指令；默认关）',
      event: 'message',
      priority: 50,
      rule: [
        { reg: '^#(批准|approve)\\s*[A-Za-z0-9_-]*\\s*$', fnc: 'approve', permission: 'master' },
        { reg: '^#(拒绝|deny)\\s*[A-Za-z0-9_-]*\\s*$', fnc: 'deny', permission: 'master' },
        { reg: '^#待审批$', fnc: 'listPending', permission: 'master' }
      ]
    })
  }

  async #requireEnabled(detail = false) {
    if (isToolApprovalEnabled()) return true
    await this.reply(
      detail
        ? '交互审批未开启（默认关）。开启：security.approval.enabled=true'
        : '交互审批未开启（ai-workflow.security.approval.enabled，默认关）'
    )
    return false
  }

  async #resolve(action, okVerb, failVerb) {
    if (!(await this.#requireEnabled())) return true
    const parsed = parseApprovalCommand(this.e.msg, action)
    const result = resolveToolApproval(parsed?.id || '', action)
    await this.reply(result.ok ? `已${okVerb} ${result.id}` : result.error || `${failVerb}失败`)
    return true
  }

  approve() {
    return this.#resolve('allow', '批准', '批准')
  }

  deny() {
    return this.#resolve('deny', '拒绝', '拒绝')
  }

  async listPending() {
    if (!(await this.#requireEnabled(true))) return true
    const list = listPendingApprovals()
    if (!list.length) {
      await this.reply('当前无待审批')
      return true
    }
    const lines = list.map((m) => `- ${m.id}: ${m.toolName} — ${m.reason}`)
    await this.reply(
      `待审批（#批准${list[0].id} 或 #批准 ${list[0].id}；仅一条时可直接 #批准）：\n${lines.join('\n')}`
    )
    return true
  }
}
