/**
 * 葵子 的 plugin 的 runtime，可通过 e.runtime 访问
 * 核心运行时，不包含游戏特定功能
 */
import lodash from 'lodash'
import fs from 'node:fs/promises'
import path from 'node:path'
import common from '#utils/common.js'
import runtimeConfig from '#infrastructure/config/config.js'
import RendererLoader from '#infrastructure/renderer/loader.js'
import Handler from './handler.js'

const gLogger = (): any => (globalThis as any).logger
const gAgentRuntime = (): any => (globalThis as any).AgentRuntime
const gMsgSegment = (): any => (globalThis as any).msgSegment

/**
 * 运行时扩展注册器
 */
class RuntimeExtensionRegistry {
  extensions = new Map<string, any>()

  /**
   * 注册运行时扩展
   */
  register(name: string, extension: any, options: { replace?: boolean } = {}) {
    const key = String(name || '').trim()
    if (!key) return false
    const replace = options?.replace === true
    if (this.extensions.has(key) && !replace) {
      gLogger()?.warn?.(`[PluginRuntime] 扩展已存在，跳过注册: ${key}`)
      return false
    }
    this.extensions.set(key, extension)
    gLogger()?.info?.(`[PluginRuntime] 注册扩展: ${key}${replace ? ' (replace)' : ''}`)
    return true
  }

  /**
   * 卸载运行时扩展（用于热重载释放引用）
   */
  unregister(name: string) {
    const key = String(name || '').trim()
    if (!key) return false
    return this.extensions.delete(key)
  }

  /**
   * 清空所有扩展（谨慎使用）
   */
  clear() {
    this.extensions.clear()
  }

  /**
   * 获取扩展
   */
  get(name: string) {
    return this.extensions.get(name)
  }

  /**
   * 检查扩展是否存在
   */
  has(name: string) {
    return this.extensions.has(name)
  }

  /**
   * 获取所有扩展
   */
  getAll() {
    return Array.from(this.extensions.entries())
  }
}

const extensionRegistry = new RuntimeExtensionRegistry()

/** 事件句柄放 WeakMap，避免 own 属性 `runtime.e` ↔ `e.runtime` 自指嵌套 */
const runtimeEvents = new WeakMap<object, any>()

/**
 * 核心运行时类
 *
 * 提供插件运行时的核心功能，包括扩展管理、渲染、消息处理等。
 * 每个插件实例都会有一个Runtime实例，用于访问系统功能。
 */
export default class PluginRuntime {
  _extensions: Record<string, any> = {}
  handler: {
    has: typeof Handler.has
    call: typeof Handler.call
    callAll: typeof Handler.callAll
  }

  constructor(e: any) {
    runtimeEvents.set(this, e)

    this.handler = {
      has: Handler.has,
      call: Handler.call,
      callAll: Handler.callAll
    }

    // 动态加载已注册的扩展
    this._loadExtensions()
  }

  /** 当前事件（API：e.runtime.e / this.e） */
  get e() {
    return runtimeEvents.get(this)
  }

  /**
   * 加载所有已注册的扩展
   */
  _loadExtensions() {
    for (const [name, Extension] of extensionRegistry.getAll()) {
      try {
        if (typeof Extension === 'function') {
          // 如果是类，创建实例
          if (Extension.prototype) {
            this._extensions[name] = new Extension(this.e, this)
          } else {
            // 如果是函数，直接调用
            const ext = Extension(this.e, this)
            if (ext) {
              this._extensions[name] = ext
            }
          }
        } else if (typeof Extension === 'object') {
          // 如果是对象，直接使用
          this._extensions[name] = Extension
        }
      } catch (error: any) {
        gLogger()?.error?.(`[PluginRuntime] 加载扩展 ${name} 失败: ${error.message}`)
      }
    }
  }

  /**
   * 获取扩展实例
   */
  getExtension(name: string) {
    return this._extensions[name]
  }

  get runtimeConfig() {
    return runtimeConfig
  }

  get common() {
    return common
  }

  /**
   * 代理访问扩展的属性
   */
  get game() {
    return this.getExtension('game')
  }

  /**
   * 渲染方法
   * @param plugin plugin key
   * @param tplPath html文件路径，相对于plugin resources目录
   * @param data 渲染数据
   * @param runtimeCfg 渲染配置
   */
  async render(
    plugin: string,
    tplPath: string,
    data: Record<string, any> = {},
    runtimeCfg: Record<string, any> = {}
  ) {
    const cleanPath = String(tplPath || '').replace(/\.html$/, '')
    const parts = lodash.filter(cleanPath.split('/'), Boolean)
    const normalizedPath = parts.join('/') || 'index'

    // 创建目录
    await gAgentRuntime()?.mkdir?.(`trash/html/${plugin}/${normalizedPath}`)

    // 自动计算pluResPath
    const resourcesPath = path.join('resources', plugin)
    const tplFile = path.join(resourcesPath, `${normalizedPath}.html`)
    const pluResPath = path.relative(path.dirname(tplFile), resourcesPath) + '/'

    // 基础渲染data
    data = {
      sys: {
        scale: 1
      },
      _res_path: pluResPath,
      _plugin: plugin,
      _htmlPath: normalizedPath,
      pluResPath,
      tplFile,
      saveId: data.saveId || data.save_id || parts[parts.length - 1] || 'index',
      ...data
    }

    // 让扩展添加自己的渲染数据
    for (const [, ext] of Object.entries(this._extensions)) {
      if (ext && typeof ext.enhanceRenderData === 'function') {
        data = (await ext.enhanceRenderData(data, plugin, path)) || data
      }
    }

    // 处理beforeRender
    if (runtimeCfg.beforeRender) {
      data = runtimeCfg.beforeRender({ data }) || data
    }

    // 保存模板数据（开发模式）
    if (process.argv.includes('dev')) {
      const saveDir = await gAgentRuntime()?.mkdir?.(`trash/ViewData/${plugin}`)
      const file = `${saveDir}/${data._htmlPath.split('/').join('_')}.json`
      await fs.writeFile(file, JSON.stringify(data))
    }

    await RendererLoader.ensureLoaded()
    const renderer = RendererLoader.getRenderer()
    if (!renderer || typeof renderer.render !== 'function') {
      throw new Error(
        '未加载到可用渲染器(puppeteer/playwright)，请检查 src/renderers 与 agt.browser.renderer'
      )
    }
    const img = await renderer.render(`${plugin}/${normalizedPath}`, data)
    const base64 = img ? gMsgSegment()?.image?.(img) : null
    if (runtimeCfg.retType === 'base64') {
      return base64
    }

    let ret: any = true
    if (base64) {
      if (runtimeCfg.recallMsg) {
        ret = await this.e.reply(base64, false, {})
      } else {
        ret = await this.e.reply(base64)
      }
    }
    return runtimeCfg.retType === 'msgId' ? ret : true
  }

  /**
   * 静态初始化方法
   */
  static async init(e: any) {
    // 初始化扩展
    for (const [name, Extension] of extensionRegistry.getAll()) {
      if (Extension.initCache && typeof Extension.initCache === 'function') {
        try {
          await Extension.initCache()
        } catch (error: any) {
          gLogger()?.error?.(`[PluginRuntime] 扩展 ${name} 缓存初始化失败: ${error.message}`)
        }
      }
    }

    e.runtime = new PluginRuntime(e)

    for (const name of Object.keys(e.runtime._extensions)) {
      const ext: any = e.runtime._extensions[name]
      if (ext && typeof ext.init === 'function') {
        try {
          await ext.init()
        } catch (error: any) {
          gLogger()?.error?.(`[PluginRuntime] 扩展 ${name} 初始化失败: ${error.message}`)
        }
      }
    }

    return e.runtime
  }
}
