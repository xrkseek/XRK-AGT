/**
 */
import {
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  buildExternalSearchMeta,
  normalizeBraveFreshness,
  normalizeCacheKey,
  parseWebSearchDateRange,
  readSearchCache,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  writeSearchCache,
  wrapWebContent,
  SEARCH_CACHE
} from './web-search-shared.js'

const DEFAULT_BRAVE_BASE_URL = 'https://api.search.brave.com'
const BRAVE_SEARCH_PATH = '/res/v1/web/search'

function resolveBraveApiKey(runtime: Record<string, any>) {
  return runtime?.brave?.apiKey?.trim?.() || ''
}

function resolveBraveBaseUrl(runtime: Record<string, any>) {
  const configured = runtime?.brave?.baseUrl?.trim?.() || ''
  return (configured || DEFAULT_BRAVE_BASE_URL).replace(/\/+$/, '')
}

function normalizeBraveCountry(value: unknown) {
  const c = String(value || '')
    .trim()
    .toUpperCase()
  if (!c) return undefined
  const allowed = new Set([
    'AR',
    'AU',
    'AT',
    'BE',
    'BR',
    'CA',
    'CL',
    'DK',
    'FI',
    'FR',
    'DE',
    'GR',
    'HK',
    'IN',
    'ID',
    'IT',
    'JP',
    'KR',
    'MY',
    'MX',
    'NL',
    'NZ',
    'NO',
    'CN',
    'PL',
    'PT',
    'PH',
    'RU',
    'SA',
    'ZA',
    'ES',
    'SE',
    'CH',
    'TW',
    'TR',
    'GB',
    'US',
    'ALL'
  ])
  return allowed.has(c) ? c : undefined
}

function setBraveSearchUrlParams(url: URL, params: Record<string, any>) {
  url.searchParams.set('q', params.query)
  if (params.country) url.searchParams.set('country', params.country)
  if (params.search_lang) url.searchParams.set('search_lang', params.search_lang)
  if (params.ui_lang) url.searchParams.set('ui_lang', params.ui_lang)
  if (params.freshness) {
    url.searchParams.set('freshness', params.freshness)
  } else if (params.dateAfter && params.dateBefore) {
    url.searchParams.set('freshness', `${params.dateAfter}to${params.dateBefore}`)
  } else if (params.dateAfter) {
    url.searchParams.set(
      'freshness',
      `${params.dateAfter}to${new Date().toISOString().slice(0, 10)}`
    )
  } else if (params.dateBefore) {
    url.searchParams.set('freshness', `1970-01-01to${params.dateBefore}`)
  }
  url.searchParams.set('count', String(params.count))
}

export function missingBraveApiKeyPayload() {
  return {
    error: 'missing_brave_api_key',
    message:
      'web_search (brave) needs ai-workflow.crawl.webSearch.brave.apiKey. Use provider=duckduckgo (no key) or web_fetch/browser for a specific URL.',
    docs: 'https://api.search.brave.com/'
  }
}

export async function runBraveSearch(
  params: Record<string, any>,
  runtime: Record<string, any> = {}
) {
  const apiKey = resolveBraveApiKey(runtime)
  if (!apiKey) return missingBraveApiKeyPayload()

  const query = String(params.query || '').trim()
  if (!query) throw new Error('query is required')

  const count = resolveSearchCount(params.count, runtime.maxResults ?? DEFAULT_SEARCH_COUNT)
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)

  const country = normalizeBraveCountry(params.country) ?? normalizeBraveCountry(runtime.country)
  const search_lang =
    (typeof params.search_lang === 'string' && params.search_lang.trim()) ||
    (typeof params.language === 'string' && params.language.trim()) ||
    undefined
  const ui_lang = typeof params.ui_lang === 'string' ? params.ui_lang.trim() : undefined

  const dateRange = parseWebSearchDateRange(params.date_after, params.date_before)
  if ('error' in dateRange && dateRange.error) {
    return { error: dateRange.error, message: dateRange.message }
  }

  const freshness = normalizeBraveFreshness(params.freshness)
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: 'brave',
      query,
      count,
      country: country ?? '',
      search_lang: search_lang ?? '',
      ui_lang: ui_lang ?? '',
      freshness: freshness ?? '',
      dateAfter: dateRange.dateAfter ?? '',
      dateBefore: dateRange.dateBefore ?? ''
    })
  )
  const cached = readSearchCache(SEARCH_CACHE, cacheKey) as
    | { value: Record<string, any> }
    | null
    | undefined
  if (cached) return { ...cached.value, cached: true }

  const baseUrl = resolveBraveBaseUrl(runtime)
  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = `${basePath}${BRAVE_SEARCH_PATH}`
  url.search = ''
  setBraveSearchUrlParams(url, {
    query,
    count: Math.min(count, MAX_SEARCH_COUNT),
    country,
    search_lang,
    ui_lang,
    freshness,
    dateAfter: dateRange.dateAfter,
    dateBefore: dateRange.dateBefore
  })

  const startedAt = Date.now()
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey
    },
    signal: AbortSignal.timeout(timeoutSeconds * 1000)
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Brave Search API error (${response.status}): ${detail || response.statusText}`)
  }

  const data = (await response.json()) as any
  const entries = Array.isArray(data?.web?.results) ? data.web.results : []
  const payload = {
    query,
    provider: 'brave',
    count: entries.length,
    tookMs: Date.now() - startedAt,
    externalContent: buildExternalSearchMeta('brave'),
    results: entries.map((entry: any) => {
      const title = entry.title ?? ''
      const href = entry.url ?? ''
      const description = entry.description ?? ''
      return {
        title: title ? wrapWebContent(title, 'web_search') : '',
        url: href,
        snippet: description ? wrapWebContent(description, 'web_search') : '',
        published: entry.age || undefined,
        siteName: resolveSiteName(href) || undefined
      }
    })
  }

  writeSearchCache(SEARCH_CACHE, cacheKey, payload, cacheTtlMs)
  return payload
}
