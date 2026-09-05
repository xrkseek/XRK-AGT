import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import lodash from 'lodash'
import runtimeConfig from '#infrastructure/config/config.js'
import Renderer from './Renderer.js'
import paths from '#utils/paths.js'
import RuntimeUtil from '#utils/runtime-util.js'
import { FileLoader } from '#utils/file-loader.js'
import { setRuntimeGlobal } from '#utils/runtime-globals.js'

setRuntimeGlobal('Renderer', Renderer)

type RendererInstance = {
  id: string
  render: (...args: any[]) => any
  stopAllWatchers?: () => Promise<void> | void
}

class RendererLoader {
  renderers = new Map<string, RendererInstance>()
  _loadPromise: Promise<void> | null = null

  async load() {
    if (this._loadPromise) return this._loadPromise
    this._loadPromise = this._doLoad()
    return this._loadPromise
  }

  async _doLoad() {
    const baseDir = paths.renderers
    if (!fsSync.existsSync(baseDir)) {
      RuntimeUtil.makeLog('warn', `渲染器目录不存在: ${baseDir}`, 'RendererLoader')
      return
    }
    const entries = await fs.readdir(baseDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        await this._loadRenderer(entry.name, baseDir)
      } catch (err: any) {
        RuntimeUtil.makeLog('error', `渲染器加载失败: ${entry.name} - ${err.message}`, 'RendererLoader', err)
      }
    }
    const loaded = [...this.renderers.keys()]
    if (loaded.length) RuntimeUtil.makeLog('info', `已加载渲染器: ${loaded.join(', ')}`, 'RendererLoader')
    else RuntimeUtil.makeLog('warn', '未加载任何渲染器，帮助页截图不可用', 'RendererLoader')
  }

  async _loadRenderer(name: string, baseDir: string) {
    const indexJs = path.join(baseDir, name, 'index.js')
    if (!fsSync.existsSync(indexJs)) return
    const rendererCfg = (runtimeConfig as any).getRendererConfig?.(name) || {}
    const factory = (await FileLoader.importFresh(indexJs)).default as (cfg: any) => RendererInstance
    const renderer = factory(rendererCfg)
    if (!renderer?.id || !lodash.isFunction(renderer.render)) {
      RuntimeUtil.makeLog('warn', `渲染器无效(缺 id/render): ${name}`, 'RendererLoader')
      return
    }
    this.renderers.set(renderer.id, renderer)
  }

  /** 运行时配置变更后重载单个渲染器（由 runtimeConfig 监视回调触发） */
  async reloadRenderer(type: string) {
    const baseDir = paths.renderers
    if (!type || !fsSync.existsSync(baseDir)) return
    try {
      await this._loadRenderer(type, baseDir)
      RuntimeUtil.makeLog('info', `渲染器配置已热重载: ${type}`, 'RendererLoader')
    } catch (error) {
      RuntimeUtil.makeLog('error', `渲染器配置热重载失败: ${type}`, 'RendererLoader', true)
    }
  }

  getRenderer(name = (runtimeConfig as any).agt?.browser?.renderer || 'playwright') {
    if (this.renderers.size === 0 && !this._loadPromise) void this.load()
    return (
      this.renderers.get(name) ||
      this.renderers.get('playwright') ||
      this.renderers.get('puppeteer')
    )
  }

  async ensureLoaded() {
    if (this.renderers.size > 0) return
    this._loadPromise = null
    await this.load()
  }

  async stopAllWatchers() {
    await Promise.allSettled([...this.renderers.values()].map((r) => r.stopAllWatchers?.()))
  }
}

const loader = new RendererLoader()
export default loader
