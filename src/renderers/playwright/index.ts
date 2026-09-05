// @ts-nocheck
import PlaywrightRenderer from "./lib/playwright.js"

/**
 * 创建并返回Playwright渲染器实例
 * @param {Object} config - 配置选项
 * @returns {PlaywrightRenderer} - Playwright渲染器实例
 */
export default function (config) {
  return new PlaywrightRenderer(config)
}