import PlaywrightRenderer from "./lib/playwright.js"
import type { BrowserRendererConfig } from "#infrastructure/renderer/browser-renderer-base.js"

/**
 * 创建并返回Playwright渲染器实例
 */
export default function (config: BrowserRendererConfig = {}) {
  return new PlaywrightRenderer(config)
}
