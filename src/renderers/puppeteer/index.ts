// @ts-nocheck
import Puppeteer from "./lib/puppeteer.js"

/**
 * 创建并返回Puppeteer渲染器实例
 * @param {Object} config - 配置选项
 * @returns {Puppeteer} - Puppeteer渲染器实例
 */
export default function (config) {
  return new Puppeteer(config)
}