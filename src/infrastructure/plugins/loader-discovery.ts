import path from 'path'
import fs from 'node:fs'
import paths from '#utils/paths.js'
import PluginBase from './plugin-base.js'
import Handler from './handler.js'
import { errorHandler, ErrorCodes } from '#utils/error-handler.js'
import { normalizeError } from '#utils/normalize-error.js'
import { getRuntimeGlobal } from '#utils/runtime-globals.js'
import { resolvePluginCoreLabel } from '#utils/core-fs.js'
import { resolveModuleInDir, moduleFileKey, preferSourceModules } from '#utils/module-ext.js'
import { FileLoader } from '#utils/file-loader.js'
import {
  classifyModuleImportError,
  isMissingPackageError
} from '#utils/module-import-error.js'
import { LOADER_BATCH_SIZE } from '#utils/loader-constants.js'
import { coerceTaskerId, resolveTaskerId } from '#utils/event-keys.js'

type LoggerLike = {
  info?: (msg: unknown) => void
  title?: (msg: unknown, color?: string) => void
  warn?: (msg: unknown) => void
  error?: (msg: unknown, err?: unknown) => void
  debug?: (msg: unknown, err?: unknown) => void
}

const gLogger = (): LoggerLike | undefined => getRuntimeGlobal<LoggerLike>('logger')

export type PluginFileRef = {
  name: string
  path: string
  core: string | null
}

export type PluginLoadStat = {
  name: string
  loadTime: number
  success: boolean
  error?: string
}

export type LoadedPlugin = Record<string, unknown> & {
  name: string
  event?: string
  priority?: number | 'extended' | string
  bypassThrottle?: boolean
  rule?: Array<Record<string, unknown> & { reg?: unknown }>
  task?: unknown
  tasker?: unknown
  taskers?: unknown
  handler?: unknown
  eventSubscribe?: unknown
  namespace?: string
  init?: () => unknown
  accept?: (e?: unknown) => unknown
  handleNonMatchMsg?: (...args: unknown[]) => unknown
}

export type PluginConstructor = (new () => LoadedPlugin) & { prototype: object }

export type PluginRuleTemplate = Record<string, unknown> & { reg?: unknown }

export type PluginMeta = {
  class: PluginConstructor
  key: string
  name: string
  event: string
  priority: number
  plugin: LoadedPlugin
  bypassThrottle: boolean
  taskers: Set<string> | null
  ruleTemplates: PluginRuleTemplate[]
  bypassRules: Array<{ reg: unknown }>
  isEnhancer: boolean
}

export type ScheduledTaskLike = {
  name?: string
  taskName?: string
  cron?: string
  log?: boolean
  fnc?: (...args: unknown[]) => unknown
  job?: { cancel: () => void }
}

export type PluginLoaderHost = {
  priority: PluginMeta[]
  extended: PluginMeta[]
  task: ScheduledTaskLike[]
  pluginCount: number
  defaultMsgHandlers: PluginMeta[]
  pluginLoadStats: {
    plugins: PluginLoadStat[]
    totalLoadTime: number
    startTime: number
    totalPlugins: number
    taskCount: number
    extendedCount: number
  }
  delCount: () => unknown
  createTask: () => unknown
  sortPlugins: () => void
  identifyDefaultMsgHandlers: () => void
  initEventSystem: () => unknown
  subscribeEvent: (eventType: string, cb: ((data: unknown) => void) & { _pluginKey?: string }) => unknown
  registerPluginTasks: (plugin: LoadedPlugin, name: string, key: string) => unknown
  prepareRuleTemplates: (ruleList?: unknown) => PluginRuleTemplate[]
  applyRuleTemplates: (plugin: LoadedPlugin, templates?: PluginRuleTemplate[]) => void
  collectBypassRules: (ruleTemplates?: PluginRuleTemplate[]) => Array<{ reg: unknown }>
  createRegExp: (pattern: unknown) => RegExp | false
  buildTaskerSet: (plugin: LoadedPlugin) => Set<string> | null
  importPlugin: (file: PluginFileRef, packageErr: PackageErr[], skipInit?: boolean) => Promise<PluginMeta[]>
  importPluginModule: (file: PluginFileRef, packageErr: PackageErr[]) => Promise<Record<string, unknown>>
  loadPlugin: (file: PluginFileRef, PluginClass: unknown, skipInit?: boolean) => Promise<PluginMeta | null>
  initializePlugin: (plugin: LoadedPlugin) => Promise<boolean>
  buildPluginMetadata: (
    file: PluginFileRef,
    PluginClass: PluginConstructor,
    plugin: LoadedPlugin,
    ruleTemplates: PluginRuleTemplate[]
  ) => PluginMeta
  getPlugins: () => Promise<PluginFileRef[]>
  registerPluginHandlers: (plugin: LoadedPlugin, fileKey: string) => void
  packageTips: (packageErr: PackageErr[]) => void
  analyzePluginPerformance: () => void
  normalizeTaskerList: (taskers: unknown) => string[]
  isTaskerAllowed: (taskerSet: Set<string> | null | undefined, event: unknown) => boolean
  wrapPluginAccept: (plugin: LoadedPlugin, meta?: PluginMeta | null) => (event: unknown) => Promise<unknown>
  _rebuildPluginGraph: () => void
  _pluginFileKey: (nameOrPath: unknown) => string
  _pluginQualifiedKey: (filePathOrKey: unknown, coreLabel?: string | null) => string
}

export type PackageErr = { error: unknown; file: PluginFileRef }

function isPluginConstructor(value: unknown): value is PluginConstructor {
  return typeof value === 'function' && Boolean((value as PluginConstructor).prototype)
}

export const discoveryMethods = {
  async load(this: PluginLoaderHost, isRefresh = false) {
    try {
      if (!isRefresh && this.priority.length) return

      this.pluginLoadStats.startTime = Date.now()
      this.pluginLoadStats.plugins = []
      this.priority = []
      this.extended = []
      this.delCount()

      gLogger()?.info?.('--------------------------------')
      gLogger()?.title?.('开始加载插件', 'yellow')

      const files = await this.getPlugins()
      this.pluginCount = 0
      const packageErr: PackageErr[] = []

      await FileLoader.forEachBatch(files, LOADER_BATCH_SIZE, async (file) => {
        const pluginStartTime = Date.now()
        try {
          await this.importPlugin(file, packageErr, false)
          const loadTime = Date.now() - pluginStartTime
          this.pluginLoadStats.plugins.push({ name: file.name, loadTime, success: true })
        } catch (err: unknown) {
          const loadTime = Date.now() - pluginStartTime
          this.pluginLoadStats.plugins.push({
            name: file.name,
            loadTime,
            success: false,
            error: normalizeError(err).message
          })
          errorHandler.handle(normalizeError(err), { context: 'loadPlugin', pluginName: file.name }, true)
          gLogger()?.error?.(`插件加载失败: ${file.name}`, err)
        }
      })

      this.pluginLoadStats.totalLoadTime = Date.now() - this.pluginLoadStats.startTime
      this.pluginLoadStats.totalPlugins = this.pluginCount
      this.pluginLoadStats.taskCount = this.task.length
      this.pluginLoadStats.extendedCount = this.extended.length

      this.packageTips(packageErr)
      this._rebuildPluginGraph()
      this.initEventSystem()

      gLogger()?.info?.(`加载定时任务[${this.task.length}个]`)
      gLogger()?.info?.(`加载插件[${this.pluginCount}个]`)
      gLogger()?.info?.(`加载扩展插件[${this.extended.length}个]`)
      gLogger()?.info?.(`总加载耗时: ${(this.pluginLoadStats.totalLoadTime / 1000).toFixed(4)}秒`)

      this.analyzePluginPerformance()
    } catch (error: unknown) {
      const botError = errorHandler.handle(
        normalizeError(error),
        { context: 'load', code: ErrorCodes.PLUGIN_LOAD_FAILED },
        true
      )
      gLogger()?.error?.('插件加载器初始化失败', botError)
      throw botError
    }
  },

  _rebuildPluginGraph(this: PluginLoaderHost) {
    this.createTask()
    this.sortPlugins()
    this.identifyDefaultMsgHandlers()
  },

  /** 插件文件短键名（不含 .js/.ts） */
  _pluginFileKey(this: PluginLoaderHost, nameOrPath: unknown) {
    return moduleFileKey(String(nameOrPath ?? ''))
  },

  /** 多 Core 限定键：`system-Core/ai`；已是 `core/name` 则原样返回 */
  _pluginQualifiedKey(this: PluginLoaderHost, filePathOrKey: unknown, coreLabel: string | null = null) {
    const s = String(filePathOrKey ?? '')
    if (s.includes('/') && !/\.[cm]?[jt]s$/i.test(s) && !s.includes('\\')) {
      return s.replace(/\\/g, '/')
    }
    const base = this._pluginFileKey(s)
    const label =
      coreLabel ||
      (s.includes(path.sep) || /\.[cm]?[jt]s$/i.test(s) ? resolvePluginCoreLabel(s) : null)
    return label ? `${label}/${base}` : base
  },

  /**
   * 扫描 core 下 plugin 目录（含工作区 / 子服）；未入库的本地 vendor 一并加载。
   * 同 stem 并存 .js/.ts 时优先 .ts（preferSourceModules）。
   */
  async getPlugins(this: PluginLoaderHost) {
    const ret: PluginFileRef[] = []

    try {
      const files = preferSourceModules(
        await FileLoader.getCoreSubDirFiles('plugin', {
          recursive: false
        })
      )

      for (const filePath of files) {
        const core = resolvePluginCoreLabel(filePath)
        ret.push({
          name: this._pluginQualifiedKey(filePath, core),
          path: filePath,
          core
        })
      }
    } catch (error: unknown) {
      gLogger()?.error?.('获取插件文件列表失败', error)
    }

    const allCoreDirs = await paths.getCoreDirs()
    const indexPaths = allCoreDirs.map((coreDir) =>
      resolveModuleInDir(coreDir, 'index', (p) => fs.existsSync(p))
    )

    for (let i = 0; i < allCoreDirs.length; i++) {
      const indexPath = indexPaths[i]
      if (!indexPath) continue
      const coreDir = allCoreDirs[i]
      try {
        const name = `${path.basename(coreDir)}-index`
        if (ret.some((p) => p.name === name)) continue
        ret.push({
          name,
          path: indexPath,
          core: path.basename(coreDir)
        })
      } catch (error: unknown) {
        gLogger()?.error?.(`加载 core 根目录 index 失败: ${coreDir}`, error)
      }
    }

    return ret
  },

  prepareRuleTemplates(this: PluginLoaderHost, ruleList: unknown = []) {
    if (!Array.isArray(ruleList) || !ruleList.length) return []
    return ruleList.map((rule: unknown) => {
      if (!rule || typeof rule !== 'object') return rule as PluginRuleTemplate
      const r = rule as PluginRuleTemplate
      return r.reg ? { ...r, reg: this.createRegExp(r.reg) } : r
    })
  },

  applyRuleTemplates(this: PluginLoaderHost, plugin: LoadedPlugin, templates: PluginRuleTemplate[] = []) {
    if (templates.length) plugin.rule = templates
  },

  collectBypassRules(this: PluginLoaderHost, ruleTemplates: PluginRuleTemplate[] = []) {
    return ruleTemplates.filter((rule) => rule?.reg).map((rule) => ({ reg: rule.reg }))
  },

  /**
   * 导入插件模块（优化：添加缓存和错误处理）
   * @param {Object} file - 文件信息
   * @param {Array} packageErr - 包错误收集数组
   * @returns {Promise<Object>} 导入的插件模块
   */
  async importPluginModule(this: PluginLoaderHost, file: PluginFileRef, packageErr: PackageErr[]) {
    try {
      const app = await FileLoader.importFresh(file.path)
      // 优化：简化返回逻辑
      const apps = app.apps
      if (apps && typeof apps === 'object') return apps as Record<string, unknown>
      return app
    } catch (error: unknown) {
      if (isMissingPackageError(error)) {
        packageErr.push({ error, file })
      } else {
        const classified = classifyModuleImportError(error)
        if (classified.kind === 'missing_export') {
          gLogger()?.warn?.(
            `${file.name} 导出不匹配: 缺少 ${classified.exportName}（${classified.packageName || 'unknown'}）`
          )
        } else {
          gLogger()?.debug?.(`加载插件模块错误: ${file.name}`, normalizeError(error).message)
        }
      }
      return {}
    }
  },

  /**
   * 初始化插件实例（优化：减少超时时间，后台初始化）
   * @param {Object} plugin - 插件实例
   * @returns {Promise<boolean>} 是否初始化成功
   */
  async initializePlugin(this: PluginLoaderHost, plugin: LoadedPlugin) {
    if (!plugin?.init) return true

    // 只发起一次 init；超时后勿再次调用（否则会双初始化）
    const initPromise = Promise.resolve().then(() => plugin.init?.())
    try {
      const initRes = await Promise.race([
        initPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('init_timeout')), 1500))
      ])
      return initRes !== 'return'
    } catch (err: unknown) {
      const nerr = normalizeError(err)
      if (nerr.message === 'init_timeout') {
        gLogger()?.debug?.(`插件 ${plugin.name} 初始化超时，将在后台继续（不重复 init）`)
        initPromise.catch((e: unknown) => {
          gLogger()?.error?.(`插件 ${plugin.name} 后台初始化错误: ${normalizeError(e).message}`)
        })
        return true
      }
      gLogger()?.error?.(`插件 ${plugin.name} 初始化错误: ${nerr.message}`)
      return false
    }
  },

  /**
   * 构建插件元数据（优化：同步操作，删除不必要的await）
   * @param {Object} file - 文件信息
   * @param {Function} PluginClass - 插件类
   * @param {Object} plugin - 插件实例
   * @param {Array} ruleTemplates - 已准备的规则模板（必须传入）
   * @returns {Object} 插件元数据
   */
  buildPluginMetadata(
    this: PluginLoaderHost,
    file: PluginFileRef,
    PluginClass: PluginConstructor,
    plugin: LoadedPlugin,
    ruleTemplates: PluginRuleTemplate[]
  ) {
    // 优化：删除await，同步返回
    return {
      class: PluginClass,
      key: file.name,
      name: plugin.name,
      event: plugin.event || 'message',
      priority: plugin.priority === 'extended' ? 0 : ((plugin.priority ?? 50) as number),
      plugin,
      bypassThrottle: plugin.bypassThrottle === true,
      taskers: this.buildTaskerSet(plugin),
      ruleTemplates,
      bypassRules: this.collectBypassRules(ruleTemplates),
      isEnhancer: plugin.priority === 'extended'
    }
  },

  /**
   * 注册插件处理器和事件订阅
   * @param {Object} plugin - 插件实例
   * @param {string} fileKey - 文件键名
   */
  registerPluginHandlers(this: PluginLoaderHost, plugin: LoadedPlugin, fileKey: string) {
    if (plugin.handler) {
      Object.values(plugin.handler as object).forEach((handler) => {
        if (!handler || typeof handler !== 'object') return
        const h = handler as Record<string, unknown>
        const { fn, key, priority } = h
        Handler.add({
          ns: (typeof plugin.namespace === 'string' ? plugin.namespace : '') || fileKey,
          key: key as string,
          self: plugin,
          priority: (priority ?? plugin.priority) as number,
          fn: plugin[String(fn)] as (this: unknown, e: unknown, args: unknown, reject: (msg?: string) => void) => unknown
        })
      })
    }

    if (plugin.eventSubscribe) {
      Object.entries(plugin.eventSubscribe as Record<string, unknown>).forEach(([eventType, handler]) => {
        if (typeof handler === 'function') {
          const boundHandler = (handler as (this: LoadedPlugin, ...args: unknown[]) => unknown).bind(plugin) as ((
            data: unknown
          ) => void) & { _pluginKey?: string }
          boundHandler._pluginKey = fileKey // 标记插件键名，用于卸载时清理
          this.subscribeEvent(eventType, boundHandler)
        }
      })
    }
  },

  /**
   * 加载单个插件类（优化：减少await，并行处理）
   * @param {Object} file - 文件信息
   * @param {Function} PluginClass - 插件类
   * @param {boolean} skipInit - 是否跳过初始化（用于热加载）
   * @returns {Promise<Object|null>} 插件元数据或null
   */
  async loadPlugin(this: PluginLoaderHost, file: PluginFileRef, PluginClass: unknown, skipInit = false) {
    try {
      if (!isPluginConstructor(PluginClass)) return null

      const plugin = new PluginClass()
      // 模块里常有工具函数再导出；普通函数也有 .prototype，必须有插件名才登记
      if (!plugin || typeof plugin.name !== 'string' || !plugin.name) return null

      this.pluginCount++

      // 准备规则模板（同步操作）
      const ruleTemplates = this.prepareRuleTemplates(plugin.rule || [])
      this.applyRuleTemplates(plugin, ruleTemplates)

      // 优化：快速初始化（1.5秒超时），失败也继续加载
      if (!skipInit) {
        await this.initializePlugin(plugin)
      }

      // 构建元数据（同步操作）
      const pluginData = this.buildPluginMetadata(file, PluginClass, plugin, ruleTemplates)

      // 注册定时任务和处理器（同步操作）
      this.registerPluginTasks(plugin, plugin.name, file.name)
      this.registerPluginHandlers(plugin, file.name)

      // 添加到对应数组
      const targetArray = plugin.priority === 'extended' ? this.extended : this.priority
      targetArray.push(pluginData)

      return pluginData
    } catch (error: unknown) {
      gLogger()?.error?.(`加载插件 ${file.name} 失败`, error)
      return null
    }
  },

  /**
   * 导入并加载插件文件（优化：并行加载多个插件类）
   * @param {Object} file - 文件信息
   * @param {Array} packageErr - 包错误收集数组
   * @param {boolean} skipInit - 是否跳过初始化
   * @returns {Promise<Array>} 加载的插件元数据数组
   */
  async importPlugin(this: PluginLoaderHost, file: PluginFileRef, packageErr: PackageErr[], skipInit = false) {
    const app = await this.importPluginModule(file, packageErr)
    if (!app || Object.keys(app).length === 0) return []

    // 优化：并行加载多个插件类
    const loadPromises = Object.entries(app).map(([key, PluginClass]) =>
      this.loadPlugin(file, PluginClass, skipInit).catch((err: unknown) => {
        gLogger()?.debug?.(`加载插件类失败: ${file.name}.${key}`, normalizeError(err).message)
        return null
      })
    )

    const results = await Promise.all(loadPromises)
    return results.filter((r): r is PluginMeta => r != null)
  },

  identifyDefaultMsgHandlers(this: PluginLoaderHost) {
    this.defaultMsgHandlers = this.priority.filter((p) => {
      if (!p?.class) return false
      try {
        return typeof new p.class().handleNonMatchMsg === 'function'
      } catch {
        return false
      }
    })
  },

  packageTips(this: PluginLoaderHost, packageErr: PackageErr[]) {
    if (!packageErr?.length) return
    gLogger()?.error?.('--------- 插件缺少 npm 依赖 ---------')
    packageErr.forEach(({ error, file }) => {
      const classified = classifyModuleImportError(error)
      const pack = classified.packageName || '未知依赖'
      gLogger()?.warn?.(`${file.name} 缺少依赖: ${pack}`)
    })
    gLogger()?.error?.('请在仓库根目录执行: pnpm add <依赖名> 后重启')
    gLogger()?.error?.('--------------------------------')
  },

  sortPlugins(this: PluginLoaderHost) {
    // 按优先级排序
    this.priority.sort((a, b) => (a.priority || 50) - (b.priority || 50))
    this.extended.sort((a, b) => (a.priority || 50) - (b.priority || 50))
  },

  createRegExp(this: PluginLoaderHost, pattern: unknown) {
    if (pattern instanceof RegExp) return pattern
    if (typeof pattern !== 'string') return false
    if (pattern === 'null' || pattern === '') return /.*/
    try {
      return new RegExp(pattern)
    } catch (e: unknown) {
      gLogger()?.error?.(`正则表达式创建失败: ${pattern}`, e)
      return false
    }
  },

  normalizeTaskerList(this: PluginLoaderHost, taskers: unknown) {
    if (!taskers) return []
    return (Array.isArray(taskers) ? taskers : [taskers]).map((item) => coerceTaskerId(item)).filter(Boolean)
  },

  buildTaskerSet(this: PluginLoaderHost, plugin: LoadedPlugin) {
    const taskers = this.normalizeTaskerList(plugin.taskers || plugin.tasker)
    return taskers.length ? new Set(taskers) : null
  },

  isTaskerAllowed(this: PluginLoaderHost, taskerSet: Set<string> | null | undefined, event: unknown) {
    if (!taskerSet?.size) return true
    const ev = event as { tasker?: unknown }
    const id = resolveTaskerId(ev) || String(ev?.tasker || '').toLowerCase()
    return taskerSet.has(id)
  },

  wrapPluginAccept(this: PluginLoaderHost, plugin: LoadedPlugin, meta: PluginMeta | null | undefined) {
    // 必须取「实例」上的 accept（Enhancer/插件覆盖）；PluginBase.accept 是类静态、恒为 undefined
    const accept =
      typeof plugin.accept === 'function' ? plugin.accept.bind(plugin) : async () => true
    return async (event: unknown) =>
      this.isTaskerAllowed(meta?.taskers, event) ? await accept(event) : false
  },

  /**
   * 分析插件加载性能（优化：简化逻辑）
   */
  analyzePluginPerformance(this: PluginLoaderHost) {
    try {
      const plugins = this.pluginLoadStats.plugins
      if (!plugins.length) return

      const slowPlugins = plugins.filter((p) => p.loadTime > 1000).sort((a, b) => b.loadTime - a.loadTime)
      if (slowPlugins.length > 0) {
        gLogger()?.warn?.(`发现 ${slowPlugins.length} 个加载较慢的插件:`)
        slowPlugins.slice(0, 5).forEach((p) => gLogger()?.warn?.(`  - ${p.name}: ${p.loadTime}ms`))
      }

      const avgLoadTime = plugins.reduce((sum, p) => sum + p.loadTime, 0) / plugins.length
      gLogger()?.debug?.(`平均插件加载时间: ${avgLoadTime.toFixed(2)}ms`)
    } catch (error: unknown) {
      gLogger()?.debug?.(`性能分析失败: ${normalizeError(error).message}`)
    }
  }
}
