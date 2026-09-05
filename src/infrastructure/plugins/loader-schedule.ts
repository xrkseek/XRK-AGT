// @ts-expect-error node-schedule 无官方类型
import schedule from 'node-schedule'

type PluginTaskDef = {
  cron?: string
  fnc?: string | ((...args: any[]) => any)
  name?: string
  log?: boolean
}

type ScheduledTask = {
  name: string
  taskName: string
  cron: string
  fnc: (...args: any[]) => any
  log: boolean
  job?: { cancel: () => void }
}

type ScheduleHost = {
  task: ScheduledTask[]
  _taskScheduleKey: string
}

const gLogger = (): any => (globalThis as any).logger

export const scheduleMethods = {
  /**
   * 注册插件定时任务
   */
  registerPluginTasks(this: ScheduleHost, plugin: Record<string, any>, pluginName: string, pluginKey: string) {
    if (!plugin.task) return

    const tasks: PluginTaskDef[] = Array.isArray(plugin.task) ? plugin.task : [plugin.task]
    tasks.forEach((t) => {
      if (!t?.cron || !t.fnc) return

      let fnc: ((...args: any[]) => any) | null = null
      // 字符串 fnc 解析到插件实例方法（勿查 PluginBase 类上不存在的方法名）
      if (typeof t.fnc === 'string') {
        if (typeof plugin[t.fnc] !== 'function') {
          gLogger()?.warn?.(`定时任务 ${t.name || pluginName} 的 fnc「${t.fnc}」不是插件实例方法，已跳过`)
          return
        }
        fnc = plugin[t.fnc].bind(plugin)
      } else if (typeof t.fnc === 'function') {
        fnc = t.fnc
      } else {
        gLogger()?.warn?.(`定时任务 ${t.name || pluginName} 的 fnc 不是函数或函数名无效，已跳过`)
        return
      }

      this.task.push({
        name: pluginKey, // 使用插件键名，便于卸载时精确匹配
        taskName: t.name || pluginName, // 保存原始任务名称用于日志
        cron: t.cron,
        fnc: fnc!,
        // 默认可静默；挂机刷屏多因默认真导致「开始执行/执行完成」刷 console
        log: t.log === true
      })
    })
  },

  createTask(this: ScheduleHost) {
    const scheduleKey = this.task
      .map((t) => `${t.name}\0${t.cron}\0${t.taskName ?? ''}\0${t.log ? 1 : 0}`)
      .sort()
      .join('\n')
    if (scheduleKey === this._taskScheduleKey) return
    this._taskScheduleKey = scheduleKey

    const created = new Set<string>()

    for (const task of this.task) {
      task.job?.cancel()

      // 使用任务名称（如果有）或插件键名
      const taskDisplayName = task.taskName || task.name
      const name = `[${taskDisplayName}][${task.cron}]`
      if (created.has(name)) {
        gLogger()?.warn?.(`重复定时任务 ${name} 已跳过`)
        continue
      }

      created.add(name)
      gLogger()?.debug?.(`加载定时任务 ${name}`)

      const cronExp = task.cron.split(/\s+/).slice(0, 6).join(' ')
      task.job = schedule.scheduleJob(cronExp, async () => {
        try {
          const start = Date.now()
          if (task.log) gLogger()?.mark?.(`${name} 开始执行`)
          await task.fnc()
          if (task.log) gLogger()?.mark?.(`${name} 执行完成 ${Date.now() - start}ms`)
        } catch (err) {
          gLogger()?.error?.(`定时任务 ${name} 执行失败`, err)
        }
      })
    }
  }
}
