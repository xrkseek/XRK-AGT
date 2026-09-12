import type { BrowserRendererConfig } from "#infrastructure/renderer/browser-renderer-base.js"
import Puppeteer from "./lib/puppeteer.js"

/**
 * 创建并返回Puppeteer渲染器实例
 */
export default function (config: BrowserRendererConfig = {}) {
  return new Puppeteer(config)
}
