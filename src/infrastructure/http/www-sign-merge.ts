/**
 * sign.json 与主服 server 配置合并：sign 已写字段优先，未写则回落主服。
 * 仅覆盖「可按挂载点覆盖」的段（static / rateLimit），不改 host/port 等全局项。
 */
import rateLimit from 'express-rate-limit'
import { isPrivateOrLoopbackAddress } from '#infrastructure/http/auth.js'

export type WwwRateLimitOverlay =
  | null
  | { enabled: false }
  | { enabled: true; windowMs?: number; max?: number; message?: string }

/**
 * 深度合并：overlay 中已定义的键覆盖 base；`undefined` 不覆盖。
 * 数组整段替换（不做按索引合并）。
 */
export function mergePreferDefined(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) {
    return base !== null && typeof base === 'object' && !Array.isArray(base) ? { ...(base as object) } : base
  }
  if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) {
    return overlay
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return { ...(overlay as object) }
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(overlay as Record<string, unknown>)) {
    if (v === undefined) continue
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      out[k] !== null &&
      typeof out[k] === 'object' &&
      !Array.isArray(out[k])
    ) {
      out[k] = mergePreferDefined(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 解析本挂载点相对主服的覆盖项。
 */
export function resolveWwwMountOverlays(
  sign: Record<string, any> | null | undefined,
  serverOrRoot: Record<string, any> = {}
): { static: Record<string, any>; rateLimit: WwwRateLimitOverlay } {
  const server =
    serverOrRoot && typeof serverOrRoot === 'object' && serverOrRoot.server
      ? serverOrRoot.server
      : serverOrRoot || {}
  const serverStatic = server.static && typeof server.static === 'object' ? server.static : {}
  const signStatic =
    sign?.static && typeof sign.static === 'object' && !Array.isArray(sign.static) ? sign.static : {}
  const topCache = sign && sign.cacheTime != null ? { cacheTime: sign.cacheTime } : {}
  const staticMerged = mergePreferDefined(serverStatic, { ...signStatic, ...topCache }) as Record<
    string,
    any
  >

  let mountRateLimit: WwwRateLimitOverlay = null
  if (sign?.rateLimit && typeof sign.rateLimit === 'object' && !Array.isArray(sign.rateLimit)) {
    const serverRl = server.rateLimit && typeof server.rateLimit === 'object' ? server.rateLimit : {}
    const merged = mergePreferDefined(serverRl, sign.rateLimit) as Record<string, any>
    if (merged.enabled === false) {
      mountRateLimit = { enabled: false }
    } else {
      const fromMount =
        merged.mount && typeof merged.mount === 'object' && !Array.isArray(merged.mount)
          ? merged.mount
          : null
      const fromGlobal =
        merged.global && typeof merged.global === 'object' && !Array.isArray(merged.global)
          ? merged.global
          : {}
      const leaf = fromMount
        ? (mergePreferDefined(fromGlobal, fromMount) as Record<string, any>)
        : {
            windowMs: merged.windowMs ?? fromGlobal.windowMs,
            max: merged.max ?? fromGlobal.max,
            message: merged.message ?? fromGlobal.message
          }
      mountRateLimit = {
        enabled: true,
        windowMs: leaf.windowMs,
        max: leaf.max,
        message: leaf.message
      }
    }
  }

  return { static: staticMerged, rateLimit: mountRateLimit }
}

/**
 * 在全局 `createStaticOptions` 基础上套本挂载的 static 覆盖。
 */
export function applyWwwStaticOverlay(
  baseStaticOptions: Record<string, any>,
  overlayStatic: Record<string, any> = {}
) {
  const o = overlayStatic && typeof overlayStatic === 'object' ? overlayStatic : {}
  return {
    ...baseStaticOptions,
    ...(o.index !== undefined ? { index: o.index } : {}),
    ...(o.extensions !== undefined ? { extensions: o.extensions } : {}),
    ...(o.cacheTime !== undefined ? { maxAge: o.cacheTime } : {}),
    ...(o.immutable !== undefined ? { immutable: o.immutable !== false } : {})
  }
}

/**
 * 本挂载路径限流中间件；`rateLimit.enabled === false` 或未配置则返回 null。
 */
export function createWwwMountRateLimiter(
  rateLimitOverlay: { enabled?: boolean; windowMs?: number; max?: number; message?: string } | null
) {
  if (!rateLimitOverlay || rateLimitOverlay.enabled === false) return null
  return rateLimit({
    windowMs: rateLimitOverlay.windowMs || 15 * 60 * 1000,
    max: rateLimitOverlay.max || 1000,
    message: rateLimitOverlay.message || '请求过于频繁，请稍后再试',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req: any) => isPrivateOrLoopbackAddress(req.ip)
  })
}
