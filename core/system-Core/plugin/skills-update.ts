// @ts-nocheck
import {
  syncManagedSkills,
  listProjectManagedSkillRels
} from '#utils/agent-managed-skills.js'
import { resolveAgentWorkspaceAbs } from '#utils/agent-workspace-paths.js'

/** 同步项目托管技能到工作区：#skills更新（托管按种子覆盖；自建不动） */
export class SkillsUpdate extends PluginBase {
  constructor() {
    super({
      name: '技能更新',
      dsc: '#skills更新',
      event: 'message',
      priority: 55,
      rule: [
        { reg: '^#skills更新$', fnc: 'update', permission: 'master' }
      ]
    })
  }

  async update() {
    const ws = resolveAgentWorkspaceAbs()
    const result = syncManagedSkills(ws)
    if (!result.ok) {
      await this.reply(`技能更新失败：${result.error}`)
      return true
    }
    const lines = [
      '托管技能同步完成（按种子覆盖）',
      `工作区：${ws.replace(/\\/g, '/')}/skills/`,
      result.hint,
      `安装 ${result.installed?.length || 0} · 更新 ${result.updated?.length || 0} · 已是最新 ${result.unchanged?.length || 0}`,
      `种子托管包共 ${listProjectManagedSkillRels().length} 个`
    ]
    if (result.updated?.length || result.installed?.length) {
      const done = [...(result.installed || []), ...(result.updated || [])].slice(0, 10)
      lines.push(`\n本次写入：\n- ${done.join('\n- ')}${done.length >= 10 ? '\n…' : ''}`)
    }
    await this.reply(lines.join('\n'))
    return true
  }
}
