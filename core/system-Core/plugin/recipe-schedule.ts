import { listRecipes, materializeRecipe } from '#utils/recipes/recipe-loader.js'
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js'
import RuntimeUtil from '#utils/runtime-util.js'
import PluginBase from '#infrastructure/plugins/plugin-base.js';

/**
 * goose scheduler 轻量融合：agents/recipes 中带 cron 的配方按插件定时任务注册。
 * 需 ai-workflow.recipes.scheduleEnabled=true；触发时以 stdin 风格日志提示（不自动跑完整 LLM，避免误烧）。
 * 真正自动执行可后续接 chat.process；当前默认只打日志 + 可选推主人。
 */
export class RecipeSchedule extends PluginBase {
  [key: string]: any;
  constructor() {
    super({
      name: '配方定时',
      dsc: 'recipes/*.yaml cron',
      event: 'message',
      priority: 9999,
      rule: []
    })
    this.task = []
  }

  async init() {
    const cfg = getAiWorkflowConfigOptional()?.recipes ?? {}
    if (cfg.scheduleEnabled !== true) return

    const recipes = listRecipes().filter((r) => r.cron)
    this.task = recipes.map((r) => ({
      name: `recipe:${r.id}`,
      cron: r.cron,
      log: true,
      fnc: async () => {
        const { userPrompt } = materializeRecipe(r, {})
        RuntimeUtil.makeLog(
          'info',
          `[recipe-schedule] 触发 ${r.id}: ${(userPrompt || r.title).slice(0, 120)}`,
          'RecipeSchedule'
        )
      }
    }))
  }
}
