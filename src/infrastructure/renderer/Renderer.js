import template from 'art-template'
import fs from 'node:fs'
import os from 'node:os'
import RuntimeUtil from '#utils/runtime-util.js'

/**
 * 将绝对路径转为 file:// URL（Windows 下用正斜杠，避免浏览器无法加载）
 */
function toFileUrl(absPath) {
  const p = String(absPath).replace(/\\/g, '/');
  return (p.startsWith('/') ? 'file://' : 'file:///') + p;
}

/**
 * 渲染器基类
 * 提供HTML模板渲染、图片生成等功能的统一接口。
 */
export default class Renderer {
  static toFileUrl = toFileUrl;

  id = 'renderer'
  type = 'image'
  dir = './trash/html'
  html = {}

  constructor(data) {
    this.id = data.id || this.id
    this.type = data.type || this.type
    this.render = this[data.render || 'render']
    this.createDir(this.dir)
  }

  createDir(dirname) {
    // 使用 recursive: true 简化递归创建逻辑
    try {
      fs.mkdirSync(dirname, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  dealTpl(name, data) {
    const { tplFile, saveId = name } = data
    const savePath = `./trash/html/${name}/${saveId}.html`

    if (!this.html[tplFile]) {
      this.createDir(`./trash/html/${name}`)

      try {
        this.html[tplFile] = fs.readFileSync(tplFile, 'utf8')
      } catch {
        RuntimeUtil.makeLog('error', `加载html错误：${tplFile}`, 'Renderer')
        return false
      }
    }

    data.resPath = `./resources/`
    const tmpHtml = template.render(this.html[tplFile], data)
    fs.writeFileSync(savePath, tmpHtml)

    RuntimeUtil.makeLog('debug', `[图片生成][使用模板] ${savePath}`, 'Renderer')

    return savePath;
  }

  async stopAllWatchers() {
    // no-op: template hot-reload removed
  }

  async getMac() {
    const macAddr = "000000000000";
    try {
      const network = os.networkInterfaces();
      for (const key in network) {
        for (const iface of network[key]) {
          if (iface.mac && iface.mac !== "00:00:00:00:00:00") {
            return iface.mac.replace(/:/g, "");
          }
        }
      }
    } catch (e) {
      RuntimeUtil.makeLog('error', `获取MAC地址失败: ${e.message}`, 'Renderer');
    }
    return macAddr;
  }

  getInfo() {
    return {
      id: this.id,
      type: this.type
    };
  }
}
