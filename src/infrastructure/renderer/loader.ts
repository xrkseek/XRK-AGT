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
import { normalizeError } from '#utils/normalize-error.js'

setRuntimeGlobal('Renderer', Renderer)

type RendererInstance = {
  id: string
  render: (...args: unknown[]) => unknown
  stopAllWatchers?: () => Promise<void> | void
}

type RendererFactory = (cfg: Record<string, unknown>) => RendererInstance

type RuntimeConfigLike = {
  getRendererConfig?: (name: string) => Record<string, unknown>
  agt?: { browser?: { renderer?: string } }
}

/**
 * 懒加载：模块 import 时不扫目录、不启浏览器；
 * 首次 `ensureLoaded()` / `load()` 才加载 renderers。
 */
class RendererLoader {
  /** 已加载实例（类字段；import 时为空） */
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
      } catch (err: unknown) {
        const n = normalizeError(err)
        RuntimeUtil.makeLog(
          'error',
          `渲染器加载失败: ${entry.name} - ${n.message}`,
          'RendererLoader',
          true,
        )
      }
    }
    const loaded = [...this.renderers.keys()]
    if (loaded.length) RuntimeUtil.makeLog('info', `已加载渲染器: ${loaded.join(', ')}`, 'RendererLoader')
    else RuntimeUtil.makeLog('warn', '未加载任何渲染器，帮助页截图不可用', 'RendererLoader')
  }

  async _loadRenderer(name: string, baseDir: string) {
    const indexJs = path.join(baseDir, name, 'index.js')
    if (!fsSync.existsSync(indexJs)) return
    const cfg = runtimeConfig as RuntimeConfigLike
    const rendererCfg = (cfg.getRendererConfig?.(name) ?? {}) as Record<string, unknown>
    const mod = await FileLoader.importFresh(indexJs)
    const factory = (mod as { default?: RendererFactory }).default
    if (typeof factory !== 'function') {
      RuntimeUtil.makeLog('warn', `渲染器无效(缺 default factory): ${name}`, 'RendererLoader')
      return
    }
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
    } catch {
      RuntimeUtil.makeLog('error', `渲染器配置热重载失败: ${type}`, 'RendererLoader', true)
    }
  }

  getRenderer(
    name = (runtimeConfig as RuntimeConfigLike).agt?.browser?.renderer || 'playwright',
  ) {
    // 仅触发异步 load，不阻塞；调用方截图前应 await ensureLoaded()
    if (this.renderers.size === 0 && !this._loadPromise) void this.load()
    return (
      this.renderers.get(name) ||
      this.renderers.get('playwright') ||
      this.renderers.get('puppeteer')
    )
  }

  /** 截图前调用：保证已扫描并实例化渲染器（仍不强制 launch 浏览器） */
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
