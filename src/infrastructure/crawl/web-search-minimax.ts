/**
 */
import {
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  buildExternalSearchMeta,
  buildSearchCacheKey,
  readCachedSearchPayload,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  writeCachedSearchPayload,
  wrapWebContent
} from './web-search-shared.js'
import { throwWebSearchApiError, withTrustedWebSearchEndpoint } from './web-search-endpoint.js'

const MINIMAX_SEARCH_ENDPOINT_GLOBAL = 'https://api.minimax.io/v1/coding_plan/search'
const MINIMAX_SEARCH_ENDPOINT_CN = 'https://api.minimaxi.com/v1/coding_plan/search'

type MiniMaxRuntime = {
  minimax?: {
    apiKey?: string
    region?: string
    apiHost?: string
    baseUrl?: string
  }
  maxResults?: number
  timeoutSeconds?: number
  cacheTtlMinutes?: number
}

type MiniMaxSearchParams = {
  query?: string
  count?: number
}

type MiniMaxOrganicEntry = {
  title?: string
  link?: string
  snippet?: string
  date?: string
}

type MiniMaxRelatedSearch = {
  query?: unknown
}

type MiniMaxSearchResponse = {
  base_resp?: { status_code?: number; status_msg?: string }
  organic?: MiniMaxOrganicEntry[]
  related_searches?: MiniMaxRelatedSearch[]
}

function resolveMiniMaxApiKey(runtime: MiniMaxRuntime) {
  return runtime?.minimax?.apiKey?.trim?.() || ''
}

function isMiniMaxCnHost(value: unknown) {
  if (!value) return false
  try {
    return new URL(String(value)).hostname.endsWith('minimaxi.com')
  } catch {
    return String(value).includes('minimaxi.com')
  }
}

function resolveMiniMaxRegion(runtime: MiniMaxRuntime) {
  const configured = runtime?.minimax?.region?.trim?.()?.toLowerCase?.()
  if (configured === 'cn' || configured === 'global') return configured
  if (isMiniMaxCnHost(runtime?.minimax?.apiHost)) return 'cn'
  if (isMiniMaxCnHost(runtime?.minimax?.baseUrl)) return 'cn'
  return 'global'
}

function resolveMiniMaxEndpoint(runtime: MiniMaxRuntime) {
  return resolveMiniMaxRegion(runtime) === 'cn'
    ? MINIMAX_SEARCH_ENDPOINT_CN
    : MINIMAX_SEARCH_ENDPOINT_GLOBAL
}

export function missingMiniMaxApiKeyPayload() {
  return {
    error: 'missing_minimax_api_key',
    message: `web_search (minimax) needs MINIMAX_CODE_PLAN_KEY / MINIMAX_CODING_API_KEY / MINIMAX_OAUTH_TOKEN / MINIMAX_API_KEY.`,
    docs: 'docs/system-core.md'
  }
}

export async function runMiniMaxSearch(
  params: MiniMaxSearchParams,
  runtime: MiniMaxRuntime = {}
) {
  const apiKey = resolveMiniMaxApiKey(runtime)
  if (!apiKey) return missingMiniMaxApiKeyPayload()

  const query = String(params.query || '').trim()
  if (!query) throw new Error('query is required')

  const count = resolveSearchCount(params.count, runtime.maxResults ?? DEFAULT_SEARCH_COUNT)
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)
  const endpoint = resolveMiniMaxEndpoint(runtime)

  const cacheKey = buildSearchCacheKey(['minimax', endpoint, query, count])
  const cached = readCachedSearchPayload(cacheKey)
  if (cached) return cached

  const start = Date.now()
  const data = await withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ q: query })
      }
    },
    async (res: Response) => {
      if (!res.ok) await throwWebSearchApiError(res, 'MiniMax Search')
      return res.json() as Promise<MiniMaxSearchResponse>
    }
  )

  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax Search API error: ${data.base_resp.status_msg || 'unknown'}`)
  }

  const organic = Array.isArray(data.organic) ? data.organic : []
  const results = organic.slice(0, Math.min(count, MAX_SEARCH_COUNT)).map((entry) => {
    const title = entry.title ?? ''
    const url = entry.link ?? ''
    const snippet = entry.snippet ?? ''
    return {
      title: title ? wrapWebContent(title, 'web_search') : '',
      url,
      description: snippet ? wrapWebContent(snippet, 'web_search') : '',
      published: entry.date || undefined,
      siteName: resolveSiteName(url) || undefined
    }
  })

  const relatedSearches = Array.isArray(data.related_searches)
    ? data.related_searches
        .map((r) => r.query)
        .filter((q): q is string => typeof q === 'string' && q.length > 0)
        .map((q) => wrapWebContent(q, 'web_search'))
    : undefined

  const payload = {
    query,
    provider: 'minimax',
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: buildExternalSearchMeta('minimax'),
    results,
    ...(relatedSearches?.length ? { relatedSearches } : {})
  }

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs)
  return payload
}
