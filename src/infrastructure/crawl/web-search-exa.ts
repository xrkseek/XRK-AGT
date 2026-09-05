/**
 */
import {
  DEFAULT_SEARCH_COUNT,
  buildExternalSearchMeta,
  buildSearchCacheKey,
  normalizeFreshness,
  parseWebSearchDateRange,
  readCachedSearchPayload,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  writeCachedSearchPayload,
  wrapWebContent
} from './web-search-shared.js'
import { withTrustedWebSearchEndpoint } from './web-search-endpoint.js'

const EXA_SEARCH_ENDPOINT = 'https://api.exa.ai/search'
const EXA_SEARCH_TYPES = new Set(['auto', 'neural', 'fast', 'deep', 'deep-reasoning', 'instant'])
const EXA_MAX_SEARCH_COUNT = 100

function resolveExaApiKey(runtime: Record<string, any>) {
  return runtime?.exa?.apiKey?.trim?.() || ''
}

function resolveExaEndpoint(runtime: Record<string, any>) {
  const configured = runtime?.exa?.baseUrl?.trim?.() || ''
  if (!configured) return EXA_SEARCH_ENDPOINT
  const candidate = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`
  const parsed = new URL(candidate)
  const pathname = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = pathname.endsWith('/search')
    ? pathname
    : `${pathname || ''}/search`.replace('//', '/')
  return parsed.toString()
}

function resolveExaDescription(result: any) {
  if (Array.isArray(result.highlights)) {
    const text = result.highlights.filter((h: unknown) => typeof h === 'string' && (h as string).trim()).join('\n')
    if (text) return text
  }
  if (typeof result.summary === 'string' && result.summary.trim()) return result.summary
  return typeof result.text === 'string' ? result.text : ''
}

function resolveFreshnessStartDate(freshness: string) {
  const now = new Date()
  if (freshness === 'day') {
    now.setUTCDate(now.getUTCDate() - 1)
    return now.toISOString()
  }
  if (freshness === 'week') {
    now.setUTCDate(now.getUTCDate() - 7)
    return now.toISOString()
  }
  if (freshness === 'month') {
    now.setUTCMonth(now.getUTCMonth() - 1)
    return now.toISOString()
  }
  now.setUTCFullYear(now.getUTCFullYear() - 1)
  return now.toISOString()
}

function resolveExaSearchCount(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(EXA_MAX_SEARCH_COUNT, parsed))
}

export function missingExaApiKeyPayload() {
  return {
    error: 'missing_exa_api_key',
    message: 'web_search (exa) needs EXA_API_KEY.',
    docs: 'docs/system-core.md'
  }
}

export async function runExaSearch(params: Record<string, any>, runtime: Record<string, any> = {}) {
  const apiKey = resolveExaApiKey(runtime)
  if (!apiKey) return missingExaApiKeyPayload()

  const query = String(params.query || '').trim()
  if (!query) throw new Error('query is required')

  const rawType = typeof params.type === 'string' ? params.type.trim() : 'auto'
  const type = EXA_SEARCH_TYPES.has(rawType) ? rawType : 'auto'
  const count = resolveExaSearchCount(params.count, runtime.maxResults ?? DEFAULT_SEARCH_COUNT)
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)
  const endpoint = resolveExaEndpoint(runtime)

  const rawFreshness = params.freshness
  const freshness = rawFreshness ? normalizeFreshness(rawFreshness, 'exa') : undefined
  if (rawFreshness && !freshness) {
    return { error: 'invalid_freshness', message: 'freshness must be day, week, month, or year.' }
  }

  const dateRange = parseWebSearchDateRange(params.date_after, params.date_before)
  if ('error' in dateRange && dateRange.error) {
    return { error: dateRange.error, message: dateRange.message }
  }
  if (freshness && (dateRange.dateAfter || dateRange.dateBefore)) {
    return { error: 'conflicting_time_filters', message: 'Use freshness OR date range, not both.' }
  }

  const contents =
    params.contents && typeof params.contents === 'object' ? params.contents : { highlights: true }

  const cacheKey = buildSearchCacheKey([
    'exa',
    endpoint,
    type,
    query,
    count,
    freshness,
    dateRange.dateAfter,
    dateRange.dateBefore,
    JSON.stringify(contents)
  ])
  const cached = readCachedSearchPayload(cacheKey)
  if (cached) return cached

  const body: Record<string, any> = { query, numResults: count, type, contents }
  if (dateRange.dateAfter) body.startPublishedDate = dateRange.dateAfter
  else if (freshness) body.startPublishedDate = resolveFreshnessStartDate(freshness)
  if (dateRange.dateBefore) body.endPublishedDate = dateRange.dateBefore

  const start = Date.now()
  const results = (await withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds,
      init: {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'x-exa-integration': 'xrk-agt'
        },
        body: JSON.stringify(body)
      }
    },
    async (res: Response) => {
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Exa API error (${res.status}): ${detail || res.statusText}`)
      }
      const data = (await res.json()) as any
      return Array.isArray(data.results) ? data.results : []
    }
  )) as any[]

  const payload = {
    query,
    provider: 'exa',
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: buildExternalSearchMeta('exa'),
    results: results.map((entry) => {
      const title = typeof entry.title === 'string' ? entry.title : ''
      const url = typeof entry.url === 'string' ? entry.url : ''
      const description = resolveExaDescription(entry)
      const summary = typeof entry.summary === 'string' ? entry.summary : ''
      return {
        title: title ? wrapWebContent(title, 'web_search') : '',
        url,
        description: description ? wrapWebContent(description, 'web_search') : '',
        published: entry.publishedDate || undefined,
        siteName: resolveSiteName(url) || undefined,
        ...(summary ? { summary: wrapWebContent(summary, 'web_search') } : {})
      }
    })
  }

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs)
  return payload
}
