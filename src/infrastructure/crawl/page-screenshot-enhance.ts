import fs from 'node:fs'
import path from 'node:path'
import RuntimeUtil from '#utils/runtime-util.js'

/** 推荐的高 DPI 截图设备像素比 */
export const DEFAULT_DEVICE_SCALE_FACTOR = 2

/** DOM 微调：将「标签+全角/半角冒号+数字」拆为半角冒号并收紧与数字间距 */
export const DOM_TWEAK_LABEL_COLON_HALF = 'labelColonHalf'

const LABEL_COLON_HALF_CLASS = 'pss-label-colon'
const LABEL_COLON_NUM_CLASS = 'pss-label-num'

/**
 * @typedef {Object} LocalFontSpec
 * @property {string} family CSS font-family 名称
 * @property {string} file 字体文件名（位于 fontDir）
 * @property {string} [weight='400'] @font-face font-weight
 * @property {string} [loadWeight] document.fonts.load/check 用的字重，默认取 weight 首段
 */

/**
 * @typedef {Object} LocalAssetRouteSpec
 * @property {string|RegExp} match Playwright page.route 的 URL 模式（支持 ** 通配）
 * @property {string} file 本地文件名（位于 assetDir）
 * @property {string} [contentType='application/octet-stream']
 */

/**
 * @typedef {Object} LocalFontScreenshotHelperOptions
 * @property {string} fontUrlBase 与目标页同域的虚拟 URL 前缀（须以 / 结尾）
 * @property {string} fontDir 字体目录（相对 cwd 或绝对路径）
 * @property {LocalFontSpec[]} fonts
 * @property {string} [assetDir] 静态资源目录（相对 cwd 或绝对路径）
 * @property {LocalAssetRouteSpec[]} [assetRoutes] 拦截远程 URL 并回源本地文件（如图标贴图）
 * @property {string[]} [hideSelectors] 截图前 display:none 的选择器
 * @property {string} [extraCss] 追加样式（业务排版放调用方）
 * @property {LabelColonHalfTweak[]} [domTweaks] 截图前 DOM 微调（如全角冒号改半角）
 * @property {string} [logContext] RuntimeUtil.makeLog 上下文
 * @property {number} [fontWaitMs=8000] 等待字体加载超时
 */

/**
 * @typedef {Object} LabelColonHalfTweak
 * @property {typeof DOM_TWEAK_LABEL_COLON_HALF} kind
 * @property {string} selector 匹配含「标签：数字」的节点（常见为 em）
 * @property {string} [label='价格'] 冒号前标签文案
 * @property {string} [colonMarginRight='-0.14em'] 半角冒号与数字之间的负间距
 */

function resolveDir(dir: any) {
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir)
}

function fontFormat(fileName: any) {
  return fileName.endsWith('.woff2') ? 'woff2' : 'truetype'
}

function fontContentType(fileName: any) {
  return fileName.endsWith('.woff2') ? 'font/woff2' : 'font/ttf'
}

/**
 * 创建「本地字体 + 页面样式 + 区域截图」助手（HTTPS 页通过 page.route 同源回源 fontDir）
 * @param {LocalFontScreenshotHelperOptions} options
 */
export function createLocalFontScreenshotHelper(options: any) {
  const {
    fontUrlBase,
    fontDir,
    fonts,
    assetDir,
    assetRoutes = [],
    hideSelectors = [],
    extraCss = '',
    domTweaks = [],
    logContext = 'PageScreenshot',
    fontWaitMs = 8000,
  } = options

  if (!fontUrlBase || !fontDir || !fonts?.length) {
    throw new Error('createLocalFontScreenshotHelper: fontUrlBase、fontDir、fonts 为必填')
  }

  const fontDirAbs = resolveDir(fontDir)
  const assetDirAbs = assetDir ? resolveDir(assetDir) : null
  const baseUrl = fontUrlBase.endsWith('/') ? fontUrlBase : `${fontUrlBase}/`
  const routedPages = new WeakSet()
  const colonTweaks = domTweaks.filter((t: any) => t.kind === DOM_TWEAK_LABEL_COLON_HALF)

  const log = (level: any, msg: any) => RuntimeUtil.makeLog(level, msg, logContext)

  const loadSpecs = fonts.map((f: any) => ({
    family: f.family,
    loadWeight: f.loadWeight || String(f.weight || '400').split(/\s+/)[0] || '400',
  }))

  const fontPublicUrl = (fileName: any) => `${baseUrl}${encodeURIComponent(fileName)}`

  const css = (() => {
    const faces = []
    const stackParts = []
    for (const f of fonts) {
      const filePath = path.join(fontDirAbs, f.file)
      if (!fs.existsSync(filePath)) {
        log('warn', `跳过缺失字体: ${filePath}`)
        continue
      }
      const fmt = fontFormat(f.file)
      const weight = f.weight || '400'
      faces.push(
        `@font-face{font-family:'${f.family}';src:url('${fontPublicUrl(f.file)}') format('${fmt}');font-weight:${weight};font-style:normal;font-display:block;}`
      )
      stackParts.push(`'${f.family}'`)
    }

    const fallback = "'PingFang SC','Microsoft YaHei',sans-serif"
    const stack = stackParts.length ? `${stackParts.join(',')},${fallback}` : fallback
    const hideRule = hideSelectors.length
      ? `${hideSelectors.join(',')}{display:none!important;}`
      : ''
    const baseRule = stackParts.length
      ? `.content,.content *{font-family:${stack}!important;-webkit-font-smoothing:antialiased!important;-moz-osx-font-smoothing:grayscale!important;text-rendering:geometricPrecision!important;font-synthesis:none!important;}`
      : ''

    const colonHalfRules = colonTweaks.map((t: any) => {
      const gap = t.colonMarginRight ?? '-0.14em'
      return (
        `.${LABEL_COLON_HALF_CLASS}{display:inline!important;margin:0 ${gap} 0 0!important;` +
        `letter-spacing:0!important;font-variant-east-asian:normal!important;}` +
        `.${LABEL_COLON_NUM_CLASS}{margin-left:0!important;letter-spacing:0!important;}`
      )
    })

    return [hideRule, ...faces, baseRule, ...colonHalfRules, extraCss].filter(Boolean).join('')
  })()

  async function fulfillLocalFile(route: any, filePath: any, contentType: any) {
    if (!fs.existsSync(filePath)) {
      await route.abort()
      return false
    }
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' },
      body: await fs.promises.readFile(filePath),
    })
    return true
  }

  async function ensureRoutes(page: any) {
    if (routedPages.has(page)) return
    routedPages.add(page)

    for (const f of fonts) {
      const url = fontPublicUrl(f.file)
      await page.route(url, async (route: any) => {
        const filePath = path.join(fontDirAbs, f.file)
        if (!(await fulfillLocalFile(route, filePath, fontContentType(f.file)))) {
          log('warn', `字体文件不存在: ${filePath}`)
        }
      })
    }

    if (!assetDirAbs) return
    for (const spec of assetRoutes) {
      await page.route(spec.match, async (route: any) => {
        const filePath = path.join(assetDirAbs, spec.file)
        if (!(await fulfillLocalFile(route, filePath, spec.contentType || 'application/octet-stream'))) {
          log('warn', `资源文件不存在: ${filePath}`)
        }
      })
    }
  }

  async function waitFonts(page: any) {
    const fontDeadline = AbortSignal.timeout(fontWaitMs)
    await Promise.race([
      page
        .evaluate(
          (async (specs: any) => {
            const doc = (globalThis as any).document
            await Promise.all(
              specs.map(({ family, loadWeight }: any) =>
                doc.fonts.load(`${loadWeight} 16px "${family}"`)
              )
            )
            await doc.fonts.ready
          }) as any,
          loadSpecs
        )
        .catch(() => {}),
      new Promise((resolve: any) => {
        if (fontDeadline.aborted) {
          resolve()
          return
        }
        fontDeadline.addEventListener('abort', () => resolve(), { once: true })
      }),
    ])

    const families = await page.evaluate(
      ((specs: any) => {
        const doc = (globalThis as any).document
        const out: Record<string, boolean> = {}
        for (const { family, loadWeight } of specs) {
          const spec = `${loadWeight} 16px "${family}"`
          out[family] = doc.fonts.check(spec)
        }
        return out
      }) as any,
      loadSpecs
    )

    const missing = loadSpecs.filter((s: any) => !families[s.family]).map((s: any) => s.family)
    if (missing.length) log('warn', `字体未完全加载: ${missing.join(', ')}`)
  }

  async function applyColonTweaks(page: any) {
    if (!colonTweaks.length) return
    await page.evaluate(
      (({ tweaks, colonClass, numClass }: any) => {
        const doc = (globalThis as any).document
        for (const { selector, label = '价格' } of tweaks) {
          const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const re = new RegExp(`^\\s*${escaped}\\s*([：:])\\s*(\\d+)\\s*$`)
          doc.querySelectorAll(selector).forEach((el: any) => {
            const text = (el.textContent || '').replace(/\s+/g, ' ')
            const m = text.match(re)
            if (!m) return
            el.innerHTML =
              `${label}<span class="${colonClass}">:</span> <span class="${numClass}">${m[2]}</span>`
          })
        }
      }) as any,
      {
        tweaks: colonTweaks.map((t: any) => ({ selector: t.selector, label: t.label })),
        colonClass: LABEL_COLON_HALF_CLASS,
        numClass: LABEL_COLON_NUM_CLASS,
      }
    )
  }

  /** 在 goto 前注册 route（与 apply 内 ensureRoutes 幂等） */
  async function prepare(page: any) {
    await ensureRoutes(page)
  }

  /** @param {import('playwright').Page} page */
  async function apply(page: any) {
    await ensureRoutes(page)
    if (css) await page.addStyleTag({ content: css })
    await waitFonts(page)
    await page
      .evaluate((() => {
        ;(globalThis as any).document.getAnimations?.().forEach((a: any) => a.cancel?.())
      }) as any)
      .catch(() => {})
    await applyColonTweaks(page)
  }

  /** @param {import('playwright').Page} page @param {string} [selector='.content'] */
  async function capture(page: any, selector: any = '.content') {
    const shotOpts = { type: 'png', animations: 'disabled', caret: 'hide', scale: 'device' }
    const locator = page.locator(selector).first()
    return locator.screenshot(shotOpts)
  }

  return { prepare, apply, capture }
}
