import { errorHandler, ErrorCodes } from '#utils/error-handler.js'
import { EventDeduplicator, IntelligentCache, PluginMatcher } from '#utils/neural-algorithms.js'
import { discoveryMethods } from './loader-discovery.js'
import { dealMethods } from './loader-deal.js'
import { scheduleMethods } from './loader-schedule.js'
import { hotReloadMethods } from './loader-hot-reload.js'
import { neuralMethods } from './loader-neural.js'

const gLogger = (): any => (globalThis as any).logger

class PluginLoader {
  priority: any[] = []
  extended: any[] = []
  task: any[] = []
  cooldowns = {
    group: new Map<string, unknown>(),
    single: new Map<string, unknown>()
  }
  msgThrottle = new Map<string, unknown>()
  eventThrottle = new Map<string, unknown>()
  defaultMsgHandlers: any[] = []
  eventSubscribers = new Map<string, Array<(data: any) => void>>()
  pluginCount = 0
  eventHistoryCache = new IntelligentCache({ maxSize: 1000, ttl: 3600000 })
  eventDeduplicator = new EventDeduplicator({
    similarityThreshold: 0.85,
    timeWindow: 60000,
    maxHistory: 1000
  })
  pluginMatcher = new PluginMatcher()
  cleanupTimer: ReturnType<typeof setInterval> | null = null
  pluginLoadStats = {
    plugins: [] as any[],
    totalLoadTime: 0,
    startTime: 0,
    totalPlugins: 0,
    taskCount: 0,
    extendedCount: 0
  }
  _taskScheduleKey = ''

  async destroy() {
    try {
      this.task.forEach((task) => task.job?.cancel())
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer)
        this.cleanupTimer = null
      }

      this.priority = []
      this.extended = []
      this.task = []
      this.cooldowns.group.clear()
      this.cooldowns.single.clear()
      this.msgThrottle.clear()
      this.eventThrottle.clear()
      this.eventSubscribers.clear()
      this.eventHistoryCache.stopCleanup()
      this.eventHistoryCache.clear()

      gLogger()?.info?.('插件加载器已销毁')
    } catch (error) {
      errorHandler.handle(error as Error, { context: 'destroy', code: ErrorCodes.SYSTEM_ERROR }, true)
      gLogger()?.error?.('销毁插件加载器失败', error)
    }
  }
}

Object.assign(
  PluginLoader.prototype,
  discoveryMethods,
  dealMethods,
  scheduleMethods,
  hotReloadMethods,
  neuralMethods
)

export default new PluginLoader()
