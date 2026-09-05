import paths from '#utils/paths.js'
import Handler from './handler.js'
import { errorHandler, ErrorCodes } from '#utils/error-handler.js'
import { findInCoreSubDirs } from '#utils/core-fs.js'

const gLogger = (): any => (globalThis as any).logger

type HotReloadHost = {
  task: Array<{ name: string; job?: { cancel: () => void } }>
  priority: Array<{ key: string; plugin?: any }>
  extended: Array<{ key: string; plugin?: any }>
  eventSubscribers: Map<string, Array<((data: any) => void) & { _pluginKey?: string }>>
  _pluginQualifiedKey: (key: string) => string
  _pluginFileKey: (key: string) => string
  identifyDefaultMsgHandlers: () => void
  importPlugin: (file: { name: string; path: string }, acc: any[], flag: boolean) => Promise<any[]>
  _rebuildPluginGraph: () => void
  unloadPlugin: (key: string) => void
  findPluginFilePath: (key: string) => Promise<string | null>
  buildPluginFileObject: (filePath: string, key: string) => { name: string; path: string }
}

export const hotReloadMethods = {
  /**
   * 卸载插件（清理相关资源）
   */
  unloadPlugin(this: HotReloadHost, key: string) {
    const normalizedKey = this._pluginQualifiedKey(key)
    const shortKey = this._pluginFileKey(key)
    const matchesKey = (pluginKey: string) => {
      const q = this._pluginQualifiedKey(pluginKey)
      if (q === normalizedKey) return true
      // 兼容旧 basename 键：仅当限定键后缀匹配且调用方给的是短名时
      if (!String(key).includes('/')) {
        return this._pluginFileKey(pluginKey) === shortKey || q.endsWith(`/${shortKey}`)
      }
      return false
    }

    // 清理定时任务（精确匹配插件键名）
    this.task = this.task.filter((task) => {
      if (matchesKey(task.name)) {
        task.job?.cancel()
        return false
      }
      return true
    })

    // 清理插件数组
    const removedPlugins: Array<{ key: string; plugin?: any }> = []
    this.priority = this.priority.filter((p) => {
      if (matchesKey(p.key)) {
        removedPlugins.push(p)
        return false
      }
      return true
    })
    this.extended = this.extended.filter((p) => {
      if (matchesKey(p.key)) {
        removedPlugins.push(p)
        return false
      }
      return true
    })

    // 释放插件实例资源
    for (const pluginData of removedPlugins) {
      const inst = pluginData.plugin
      if (typeof inst?.destroy === 'function') {
        Promise.resolve(inst.destroy()).catch((err: Error) => {
          gLogger()?.warn?.(`插件 ${normalizedKey} destroy 失败: ${err.message}`)
        })
      }
    }

    // 清理 Handler（使用插件的命名空间）
    for (const pluginData of removedPlugins) {
      const namespace = pluginData.plugin?.namespace || normalizedKey
      Handler.del(namespace)
    }

    // 清理事件订阅（需要遍历所有订阅者找到对应的插件）
    for (const [eventType, subscribers] of this.eventSubscribers) {
      const filtered = subscribers.filter((sub) => {
        return !sub._pluginKey || !matchesKey(sub._pluginKey)
      })
      if (filtered.length !== subscribers.length) {
        this.eventSubscribers.set(eventType, filtered)
      }
    }

    // 重新识别默认消息处理器
    this.identifyDefaultMsgHandlers()
  },

  /**
   * 查找插件文件路径
   */
  async findPluginFilePath(key: string): Promise<string | null> {
    try {
      const pluginDirs = await paths.getCoreSubDirs('plugin')
      return findInCoreSubDirs(pluginDirs, key)
    } catch (error) {
      gLogger()?.error?.(`查找插件文件失败: ${key}`, error)
      return null
    }
  },

  /**
   * 构建插件文件对象（用于导入）
   */
  buildPluginFileObject(filePath: string, key: string) {
    return {
      name: key,
      path: filePath
    }
  },

  /**
   * 重新加载插件（手动/工具调用；无文件监视）
   */
  async changePlugin(this: HotReloadHost, key: string, filePath: string | null = null) {
    if (!key) {
      gLogger()?.error?.('重新加载插件: 缺少插件key')
      return
    }

    try {
      const pluginPath = filePath ?? (await this.findPluginFilePath(key))
      if (!pluginPath) {
        gLogger()?.error?.(`插件文件未找到: ${key}`)
        return
      }

      this.unloadPlugin(key)

      const file = this.buildPluginFileObject(pluginPath, key)
      const loadedPlugins = await this.importPlugin(file, [], false)

      if (loadedPlugins.length > 0) {
        this._rebuildPluginGraph()
        gLogger()?.mark?.(`[重新加载插件][${key}] 更新了 ${loadedPlugins.length} 个插件实例`)
      }
    } catch (error) {
      errorHandler.handle(
        error as Error,
        { context: 'changePlugin', pluginKey: key, code: ErrorCodes.PLUGIN_LOAD_FAILED },
        true
      )
      gLogger()?.error?.(`重新加载插件错误: ${key}`, error)
    }
  }
}
