/**
 * Playwright 导航 SSRF 守卫
 * waitUntil 取值对齐官方 Page.goto：load | domcontentloaded | networkidle | commit
 * @see https://playwright.dev/docs/api/class-page#page-goto
 */
import { isIP } from 'node:net'
import {
  SsrFBlockedError,
  assertUrlSafeForFetch,
  resolvePinnedHostnameWithPolicy,
  isPrivateNetworkAllowedByPolicy,
  matchesHostnameAllowlist,
  normalizeHostnameAllowlist
} from './ssrf-policy.js'
import { normalizeHostname } from './ssrf-ip-policy.js'

export { SsrFBlockedError }

export type PlaywrightWaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit'

/** @see https://playwright.dev/docs/api/class-page#page-goto — networkidle 官方 DISCOURAGED */
export const PLAYWRIGHT_WAIT_UNTIL = Object.freeze([
  'load',
  'domcontentloaded',
  'networkidle',
  'commit'
] as const)

export function normalizePlaywrightWaitUntil(
  raw: unknown,
  fallback: PlaywrightWaitUntil = 'load'
): PlaywrightWaitUntil {
  const v = String(raw ?? fallback)
    .trim()
    .toLowerCase()
  if ((PLAYWRIGHT_WAIT_UNTIL as readonly string[]).includes(v)) {
    return v as PlaywrightWaitUntil
  }
  return fallback
}

export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidBrowserNavigationUrlError'
  }
}

const NETWORK_PROTOCOLS = new Set(['http:', 'https:'])
const SAFE_NON_NETWORK = new Set(['about:blank'])

export function isPolicyDenyNavigationError(err: unknown) {
  return err instanceof SsrFBlockedError || err instanceof InvalidBrowserNavigationUrlError
}

function isIpLiteralHostname(hostname: string) {
  return isIP(normalizeHostname(hostname)) !== 0
}

function isExplicitlyAllowedBrowserHostname(hostname: string, ssrfPolicy: Record<string, any>) {
  const normalized = normalizeHostname(hostname)
  const exact = (ssrfPolicy?.allowedHostnames ?? []).map(normalizeHostname)
  if (exact.includes(normalized)) return true
  const allowlist = normalizeHostnameAllowlist(ssrfPolicy?.hostnameAllowlist)
  return allowlist.length > 0 && matchesHostnameAllowlist(normalized, allowlist)
}

export function didCrossDocumentUrlChange(page: { url: () => string }, previousUrl: string) {
  const currentUrl = page.url()
  if (currentUrl === previousUrl) return false
  try {
    const prev = new URL(previousUrl)
    const curr = new URL(currentUrl)
    if (prev.origin === curr.origin && prev.pathname === curr.pathname && prev.search === curr.search) {
      return false
    }
    return true
  } catch {
    return currentUrl !== previousUrl
  }
}

export function isHashOnlyNavigation(currentUrl: string, previousUrl: string) {
  if (currentUrl === previousUrl) return false
  try {
    const prev = new URL(previousUrl)
    const curr = new URL(currentUrl)
    return (
      prev.origin === curr.origin && prev.pathname === curr.pathname && prev.search === curr.search
    )
  } catch {
    return false
  }
}

type NavArg =
  | string
  | {
      url: string
      ssrfPolicy?: Record<string, any>
      browserProxyMode?: string
      lookupFn?: (...args: any[]) => any
    }

export async function assertBrowserNavigationAllowed(arg: NavArg, legacyPolicy?: Record<string, any>) {
  const opts = typeof arg === 'string' ? { url: arg, ssrfPolicy: legacyPolicy ?? {} } : arg
  const rawUrl = String(opts.url || '').trim()
  if (!rawUrl) throw new InvalidBrowserNavigationUrlError('url is required')

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`)
  }

  if (!NETWORK_PROTOCOLS.has(parsed.protocol)) {
    if (SAFE_NON_NETWORK.has(parsed.href)) return
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`
    )
  }

  if (
    opts.browserProxyMode === 'explicit-browser-proxy' &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      'Navigation blocked: strict browser SSRF policy cannot be enforced while browser profile is proxy-routed'
    )
  }

  const policy = opts.ssrfPolicy ?? {}
  if (
    policy.dangerouslyAllowPrivateNetwork === false &&
    !isPrivateNetworkAllowedByPolicy(policy) &&
    !isIpLiteralHostname(parsed.hostname) &&
    !isExplicitlyAllowedBrowserHostname(parsed.hostname, policy)
  ) {
    await assertUrlSafeForFetch(rawUrl, policy, opts.lookupFn)
    return
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, { policy, lookupFn: opts.lookupFn })
}

export async function assertBrowserNavigationResultAllowed(
  arg: NavArg,
  legacyPolicy?: Record<string, any>
) {
  const opts = typeof arg === 'string' ? { url: arg, ssrfPolicy: legacyPolicy ?? {} } : arg
  const rawUrl = String(opts.url ?? '').trim()
  if (!rawUrl) return
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return
  }
  if (NETWORK_PROTOCOLS.has(parsed.protocol) || SAFE_NON_NETWORK.has(parsed.href)) {
    await assertBrowserNavigationAllowed(opts)
  }
}

export async function assertBrowserNavigationResultAllowedForPage(
  page: { url: () => string },
  ssrfPolicy: Record<string, any> = {}
) {
  await assertBrowserNavigationResultAllowed({ url: page.url(), ssrfPolicy })
}

/**
 * Playwright route 拦截导航请求（gotoPageWithNavigationGuard 精简）
 */
export async function gotoWithNavigationGuard(
  page: any,
  url: string,
  opts: {
    timeoutMs?: number
    ssrfPolicy?: Record<string, any>
    onBlocked?: (err: unknown) => any
    waitUntil?: unknown
  } = {}
) {
  const { timeoutMs = 60_000, ssrfPolicy = {}, onBlocked } = opts
  const waitUntil = normalizePlaywrightWaitUntil(opts.waitUntil, 'load')
  let blockedError: unknown = null

  const handler = async (route: any, request: any) => {
    if (blockedError) {
      await route.abort().catch(() => {})
      return
    }
    const isMainFrame = request.frame() === page.mainFrame()
    const isDoc = request.isNavigationRequest?.() || request.resourceType() === 'document'
    if (!isMainFrame && !isDoc) {
      await route.continue().catch(() => {})
      return
    }
    try {
      await assertBrowserNavigationAllowed({ url: request.url(), ssrfPolicy })
    } catch (err) {
      if (isPolicyDenyNavigationError(err)) {
        if (isMainFrame) blockedError = err
        await route.abort().catch(() => {})
        return
      }
      throw err
    }
    await route.continue().catch(() => {})
  }

  await page.route('**', handler)
  try {
    const response = await page.goto(url, { timeout: timeoutMs, waitUntil })
    if (blockedError) throw blockedError
    await assertBrowserNavigationResultAllowedForPage(page, ssrfPolicy)
    return response
  } catch (err) {
    if (blockedError) {
      if (typeof onBlocked === 'function') await onBlocked(err)
      throw blockedError
    }
    throw err
  } finally {
    await page.unroute('**', handler).catch(() => {})
  }
}
