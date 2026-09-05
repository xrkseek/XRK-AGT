/**
 * 挂载各 Core 的 www。
 *
 * 决策在 `www-app-resolve.js`，与主服合并在 `www-sign-merge.js`，说明见 `docs/www-mount.md`：
 *
 * 1. **零配置静态**（无 sign）：`/${文件夹名}` → 目录本体
 * 2. **有 sign**（含纯静态 / SPA 产物 / 反代）：
 *    - 纯静态或产物静态 → 只挂产物（build 在 Bootstrap / `pnpm run build:www`）；可覆盖 static / rateLimit
 *    - 反代 → 跳过静态，Launcher 启进程
 *
 * 另：`/core/<Core名>` 始终挂该 Core 的整个 `www/`（调试/直链用）。
 * 同名对外路径先到先得；保留段见 `RESERVED_ROOT_SEGMENTS`。
 */
import path from 'node:path'
import fsSync from 'node:fs'
// @ts-expect-error express 无 @types/express（与仓库约定一致）
import express from 'express'
import RuntimeUtil from '#utils/runtime-util.js'
import paths from '#utils/paths.js'
import { statDirs } from '#utils/core-fs.js'
import runtimeConfig from '#infrastructure/config/config.js'
import {
  resolveWwwAppMount,
  resolveWwwStaticRoot,
  isWwwSignedStaticRootOk,
  wwwMountPathRootSegment
} from '#infrastructure/http/www-app-resolve.js'
import {
  resolveWwwMountOverlays,
  applyWwwStaticOverlay,
  createWwwMountRateLimiter
} from '#infrastructure/http/www-sign-merge.js'

export {
  resolveWwwAppMount,
  resolveWwwStaticRoot,
  resolveWwwPublicMountPath,
  wwwMountPathRootSegment,
  shouldProxyFrontend,
  readWwwSignFile,
  WWW_BUILD_OUT_CANDIDATES,
  isActiveFrontendSign,
  resolveWwwAppStaticRoot,
  isWwwSignedStaticRootOk,
  looksLikeFrontendSourceTree
} from '#infrastructure/http/www-app-resolve.js'

export {
  mergePreferDefined,
  resolveWwwMountOverlays,
  applyWwwStaticOverlay,
  createWwwMountRateLimiter
} from '#infrastructure/http/www-sign-merge.js'

/**
 * 不可占用的对外路径第一段。
 * `shared` 为历史保留段；产品页勿用，见 skill `xrk-www-compat`。
 */
export const RESERVED_ROOT_SEGMENTS = ['api', 'core', 'media', 'uploads', 'File', 'shared']

/**
 * @returns 已挂载路径（含 `/core/<名>` 与对外 `/…`）
 */
export async function mountCoreWwwStatic(app: any, staticOptions: Record<string, any> = {}) {
  const coreDirs = await paths.getCoreDirs()
  const mountedPaths = new Set<string>()
  const serverCfg = (runtimeConfig as any).server || {}

  for (let ci = 0; ci < coreDirs.length; ci++) {
    const coreDir = coreDirs[ci]
    const coreName = path.basename(coreDir)
    // www 未拷入 dist：始终从源码树挂载
    const wwwDir = path.join(paths.coreSource, coreName, 'www')
    const [wwwOk] = await statDirs([wwwDir])

    if (!wwwOk) continue

    const coreMountPath = `/core/${coreName}`
    if (!mountedPaths.has(coreMountPath)) {
      app.use(coreMountPath, express.static(wwwDir, staticOptions))
      mountedPaths.add(coreMountPath)
      RuntimeUtil.makeLog('info', `挂载 Core www: ${coreMountPath} -> ${wwwDir}`, 'AgentRuntime')
    }

    let dirEntries: fsSync.Dirent[] = []
    try {
      dirEntries = fsSync
        .readdirSync(wwwDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
    } catch (error: any) {
      RuntimeUtil.makeLog(
        'debug',
        `扫描 www 子目录失败: ${wwwDir} - ${error.message}`,
        'AgentRuntime'
      )
      continue
    }

    for (const entry of dirEntries) {
      const subDirName = entry.name
      const subDirPath = path.join(wwwDir, subDirName)
      const decision = resolveWwwAppMount(subDirPath) as any
      const mountPath = decision.mountPath || `/${subDirName}`
      const rootSeg = wwwMountPathRootSegment(mountPath)
      const kindLabel = decision.kind === 'signed' ? '有 sign' : '零配置静态'

      if (RESERVED_ROOT_SEGMENTS.includes(rootSeg) || RESERVED_ROOT_SEGMENTS.includes(subDirName)) {
        RuntimeUtil.makeLog(
          'warn',
          `跳过保留路径: ${mountPath} (dir=${subDirName}, core: ${coreName})`,
          'AgentRuntime'
        )
        continue
      }

      if (mountedPaths.has(mountPath)) {
        RuntimeUtil.makeLog(
          'warn',
          `路径冲突，跳过: ${mountPath} (dir=${subDirName}, core: ${coreName})，已被其他core占用`,
          'AgentRuntime'
        )
        continue
      }

      if (decision.mode === 'proxy') {
        RuntimeUtil.makeLog(
          'info',
          `${kindLabel}反代，跳过静态: ${mountPath} (dir=${subDirName}, core: ${coreName}) — ${decision.reason}`,
          'AgentRuntime'
        )
        continue
      }

      let staticRoot = decision.staticRoot
      let reason = decision.reason
      let warn = decision.warn
      const sign = decision.sign

      if (decision.kind === 'signed' && sign) {
        const resolved = resolveWwwStaticRoot(subDirPath, sign) as any
        if (!isWwwSignedStaticRootOk(subDirPath, sign, resolved)) {
          RuntimeUtil.makeLog(
            'error',
            `有 sign 无可用静态根，跳过挂载: ${mountPath} (dir=${subDirName}, core: ${coreName})` +
              ' — 请确认启动过程已 build（或 pnpm run build:www），或设 staticRoot: "." 挂纯静态',
            'AgentRuntime'
          )
          continue
        }
        staticRoot = resolved.root
        reason = resolved.via === '.' ? `有 sign 纯静态 → .` : `有 sign 静态 → ${resolved.via}`
        warn = resolved.warn
      }

      if (!staticRoot) {
        RuntimeUtil.makeLog(
          'warn',
          `静态挂载无有效根目录，跳过: ${mountPath} (dir=${subDirName}, core: ${coreName})`,
          'AgentRuntime'
        )
        continue
      }

      const overlays = resolveWwwMountOverlays(sign, serverCfg)
      const mountStaticOpts = applyWwwStaticOverlay(staticOptions, overlays.static)
      const mountLimiter = createWwwMountRateLimiter(overlays.rateLimit)
      if (mountLimiter) {
        app.use(mountPath, mountLimiter)
      }
      app.use(mountPath, express.static(staticRoot, mountStaticOpts))

      // Vue/React history 模式：无实体文件的 GET 回落到 index.html（否则 /app/sqlite 会 404）
      const spaEnabled = sign?.spa === true || sign?.historyApiFallback === true
      const spaIndex = path.join(staticRoot, 'index.html')
      if (spaEnabled && fsSync.existsSync(spaIndex)) {
        app.use(mountPath, (req: any, res: any, next: any) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return next()
          // 带扩展名的当作静态资源缺失，不吞掉 404
          if (path.extname(req.path)) return next()
          res.sendFile(spaIndex, (err: Error | null) => (err ? next(err) : undefined))
        })
        reason = `${reason}; spa→index.html`
      }

      mountedPaths.add(mountPath)
      RuntimeUtil.makeLog(
        'info',
        `挂载${kindLabel}: ${mountPath} -> ${staticRoot} (dir=${subDirName}, core: ${coreName}; ${reason})`,
        'AgentRuntime'
      )
      if (warn) {
        RuntimeUtil.makeLog('warn', `${mountPath}: ${warn}`, 'AgentRuntime')
      }
    }
  }

  return mountedPaths
}
