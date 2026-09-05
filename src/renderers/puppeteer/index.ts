import Puppeteer from "./lib/puppeteer.js"

/**
 * 创建并返回Puppeteer渲染器实例
 */
export default function (config: any) {
  return new Puppeteer(config)
}
