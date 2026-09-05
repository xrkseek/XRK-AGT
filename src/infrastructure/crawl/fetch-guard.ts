/**
 * Playwright / SSRF 受控 fetch：每跳 pin DNS、manual 重定向、环检测
 */
import {
  SsrFBlockedError,
  assertUrlSafeForFetch,
  resolvePinnedHostnameWithPolicy,
  createPinnedDispatcher,
  closeDispatcher,
  resolveSsrFPolicyForUrl
} from './ssrf-policy.js'
import { dropBodyHeaders, retainSafeHeadersForCrossOriginRedirect } from './redirect-headers.js'

const DEFAULT_MAX_REDIRECTS = 3

type HeaderBag = ConstructorParameters<typeof Headers>[0]

type FetchInit = RequestInit & {
  dispatcher?: unknown
  headers?: HeaderBag | null
}

type FetchGuardOptions = {
  maxRedirects?: number
  timeoutMs?: number
  ssrfPolicy?: Record<string, unknown>
  pinDns?: boolean
  dispatcherPolicy?: Record<string, unknown>
  allowCrossOriginUnsafeRedirectReplay?: boolean
  lookupFn?: (...args: any[]) => any
}

function getRedirectVisitKey(url: string, init?: FetchInit | null): string {
  return `${init?.method?.toUpperCase() ?? 'GET'} ${url}`
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function rewriteRedirectInitForMethod(init: FetchInit | undefined, status: number): FetchInit | undefined {
  if (!init) return init
  const currentMethod = init.method?.toUpperCase() ?? 'GET'
  const shouldForceGet =
    status === 303
      ? currentMethod !== 'GET' && currentMethod !== 'HEAD'
      : (status === 301 || status === 302) && currentMethod === 'POST'
  if (!shouldForceGet) return init
  return {
    ...init,
    method: 'GET',
    body: undefined,
    headers: dropBodyHeaders(init.headers) as HeaderBag | undefined
  }
}

function rewriteRedirectInitForCrossOrigin(
  init: FetchInit | undefined,
  allowUnsafeReplay: boolean
): FetchInit | undefined {
  if (!init || allowUnsafeReplay) return init
  const currentMethod = init.method?.toUpperCase() ?? 'GET'
  if (currentMethod === 'GET' || currentMethod === 'HEAD') return init
  return {
    ...init,
    body: undefined,
    headers: dropBodyHeaders(init.headers) as HeaderBag | undefined
  }
}

function assertHttpUrl(urlString: string): URL {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(urlString)
  } catch {
    throw new SsrFBlockedError('Invalid URL: must be http or https')
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new SsrFBlockedError('Invalid URL: must be http or https')
  }
  return parsedUrl
}

export async function fetchWithSsrFGuard(
  url: string,
  init: FetchInit = {},
  options: FetchGuardOptions = {}
): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects =
    typeof options.maxRedirects === 'number' && Number.isFinite(options.maxRedirects)
      ? Math.max(0, Math.floor(options.maxRedirects))
      : DEFAULT_MAX_REDIRECTS
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30_000)
  const ssrfPolicy = options.ssrfPolicy ?? {}
  const pinDns = options.pinDns !== false

  let currentUrl = url
  let currentInit: FetchInit = init ? { ...init } : {}
  const visited = new Set([getRedirectVisitKey(currentUrl, currentInit)])
  let redirectCount = 0

  while (true) {
    const parsedUrl = assertHttpUrl(currentUrl)

    const effectivePolicy = resolveSsrFPolicyForUrl(parsedUrl, ssrfPolicy)
    await assertUrlSafeForFetch(currentUrl, effectivePolicy, options.lookupFn)

    let dispatcher: unknown
    try {
      if (pinDns) {
        const pinned = await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
          policy: effectivePolicy,
          lookupFn: options.lookupFn
        })
        dispatcher = createPinnedDispatcher(pinned, options.dispatcherPolicy, timeoutMs)
      }

      const res = await fetch(currentUrl, {
        ...currentInit,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        ...(dispatcher ? { dispatcher } : {})
      } as RequestInit)

      if (!isRedirectStatus(res.status)) {
        return { response: res, finalUrl: currentUrl }
      }

      const location = res.headers.get('location')
      if (!location) {
        return { response: res, finalUrl: currentUrl }
      }

      redirectCount += 1
      if (redirectCount > maxRedirects) {
        throw new Error('Too many redirects')
      }

      const nextUrl = new URL(location, parsedUrl).href
      currentInit = rewriteRedirectInitForMethod(currentInit, res.status) ?? currentInit

      if (new URL(nextUrl).origin !== parsedUrl.origin) {
        currentInit =
          rewriteRedirectInitForCrossOrigin(
            currentInit,
            options.allowCrossOriginUnsafeRedirectReplay === true
          ) ?? currentInit
        if (currentInit.headers) {
          currentInit = {
            ...currentInit,
            headers: retainSafeHeadersForCrossOriginRedirect(currentInit.headers) as HeaderBag
          }
        }
      }

      const visitKey = getRedirectVisitKey(nextUrl, currentInit)
      if (visited.has(visitKey)) {
        throw new SsrFBlockedError('Redirect loop detected')
      }
      visited.add(visitKey)

      try {
        await (res.body as any)?.cancel?.()
      } catch {
        /* ignore */
      }

      currentUrl = nextUrl
    } finally {
      if (dispatcher) await closeDispatcher(dispatcher as any)
    }
  }
}

export { SsrFBlockedError }
