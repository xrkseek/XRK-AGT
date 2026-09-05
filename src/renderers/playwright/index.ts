import PlaywrightRenderer from "./lib/playwright.js"

/**
 * 创建并返回Playwright渲染器实例
 */
export default function (config: any) {
  return new PlaywrightRenderer(config)
}
