/**
 */
import {
  DEFAULT_SEARCH_COUNT,
  buildExternalSearchMeta,
  normalizeCacheKey,
  readSearchCache,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  writeSearchCache,
  wrapWebContent,
  SEARCH_CACHE
} from './web-search-shared.js'
import {
  validateSelfHostedBaseUrl,
  withSelfHostedWebSearchEndpoint,
  withTrustedWebSearchEndpoint
} from './web-search-endpoint.js'

const MAX_RESPONSE_BYTES = 1_000_000

function resolveSearxngBaseUrl(runtime: Record<string, any>) {
  return runtime?.searxng?.baseUrl?.trim?.() || ''
}

function buildSearxngSearchUrl(
  baseUrl: string,
  query: string,
  categories?: string,
  language?: string
) {
  const url = new URL(baseUrl)
  const pathname = url.pathname.endsWith('/') ? `${url.pathname}search` : `${url.pathname}/search`
  url.pathname = pathname
  url.search = ''
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  if (categories) url.searchParams.set('categories', categories)
  if (language) url.searchParams.set('language', language)
  return url.toString()
}

function normalizeSearxngResult(value: any) {
  if (!value || typeof value !== 'object') return null
  if (typeof value.url !== 'string' || typeof value.title !== 'string') return null
  return {
    url: value.url,
    title: value.title,
    content: typeof value.content === 'string' ? value.content : undefined,
    img_src: typeof value.img_src === 'string' ? value.img_src : undefined
  }
}

function parseSearxngResponseText(text: string, count: number) {
  const parsed = JSON.parse(text)
  const rawResults = Array.isArray(parsed?.results) ? parsed.results : []
  const results: Array<{
    url: string
    title: string
    content?: string
    img_src?: string
  }> = []
  for (const raw of rawResults) {
    const result = normalizeSearxngResult(raw)
    if (result) results.push(result)
    if (results.length >= count) break
  }
  return results
}

function shouldRetryWithGeneral(categories?: string) {
  if (!categories) return false
  const normalized = categories
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
  return normalized.length > 0 && !normalized.includes('general')
}

async function fetchSearxngResults(params: {
  baseUrl: string
  query: string
  categories?: string
  language?: string
  timeoutSeconds: number
  count: number
  endpointMode: string
}) {
  const url = buildSearxngSearchUrl(params.baseUrl, params.query, params.categories, params.language)
  const withEndpoint =
    params.endpointMode === 'selfHosted'
      ? withSelfHostedWebSearchEndpoint
      : withTrustedWebSearchEndpoint

  return withEndpoint(
    {
      url,
      timeoutSeconds: params.timeoutSeconds,
      init: { method: 'GET', headers: { Accept: 'application/json' } }
    },
    async (response: Response) => {
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(
          `SearXNG search error (${response.status}): ${detail || response.statusText}`
        )
      }
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('SearXNG response too large.')
      return parseSearxngResponseText(text, params.count)
    }
  )
}

export function missingSearxngBaseUrlPayload() {
  return {
    error: 'missing_searxng_base_url',
    message:
      'web_search (searxng) needs SEARXNG_BASE_URL (self-hosted instance with JSON format enabled).',
    docs: 'https://docs.searxng.org/'
  }
}

export async function runSearxngSearch(
  params: Record<string, any>,
  runtime: Record<string, any> = {}
) {
  const baseUrl = resolveSearxngBaseUrl(runtime)
  if (!baseUrl) return missingSearxngBaseUrlPayload()

  const query = String(params.query || '').trim()
  if (!query) throw new Error('query is required')

  const count = resolveSearchCount(params.count, runtime.maxResults ?? DEFAULT_SEARCH_COUNT)
  const categories =
    (typeof params.categories === 'string' && params.categories.trim()) ||
    runtime?.searxng?.categories?.trim?.() ||
    undefined
  const language =
    (typeof params.language === 'string' && params.language.trim()) ||
    runtime?.searxng?.language?.trim?.() ||
    undefined
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)

  const endpointMode = await validateSelfHostedBaseUrl(baseUrl)

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: 'searxng',
      query,
      count,
      categories: categories ?? '',
      language: language ?? '',
      baseUrl
    })
  )
  const cached = readSearchCache(SEARCH_CACHE, cacheKey) as
    | { value: Record<string, any> }
    | null
    | undefined
  if (cached) return { ...cached.value, cached: true }

  const startedAt = Date.now()
  let results = await fetchSearxngResults({
    baseUrl,
    query,
    categories,
    language,
    timeoutSeconds,
    count,
    endpointMode
  })
  if (results.length === 0 && shouldRetryWithGeneral(categories)) {
    results = await fetchSearxngResults({
      baseUrl,
      query,
      categories: 'general',
      language,
      timeoutSeconds,
      count,
      endpointMode
    })
  }

  const payload = {
    query,
    provider: 'searxng',
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: buildExternalSearchMeta('searxng'),
    results: results.map((result) => ({
      title: wrapWebContent(result.title, 'web_search'),
      url: result.url,
      snippet: result.content ? wrapWebContent(result.content, 'web_search') : '',
      siteName: resolveSiteName(result.url) || undefined,
      ...(result.img_src ? { img_src: result.img_src } : {})
    }))
  }

  writeSearchCache(SEARCH_CACHE, cacheKey, payload, cacheTtlMs)
  return payload
}
