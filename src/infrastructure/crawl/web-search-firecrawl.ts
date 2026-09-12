/**
 */
import {
  DEFAULT_SEARCH_COUNT,
  buildExternalSearchMeta,
  normalizeCacheKey,
  readSearchCache,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  writeSearchCache,
  wrapWebContent,
  SEARCH_CACHE
} from './web-search-shared.js'
import {
  validateSelfHostedBaseUrl,
  withSelfHostedWebSearchEndpoint,
  withTrustedWebSearchEndpoint
} from './web-search-endpoint.js'

const DEFAULT_FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev'
const ALLOWED_FIRECRAWL_HOSTS = new Set(['api.firecrawl.dev'])

type FirecrawlRuntime = {
  firecrawl?: { apiKey?: string; baseUrl?: string }
  timeoutSeconds?: number
  cacheTtlMinutes?: number
}

type FirecrawlSearchParams = {
  query?: string
  count?: number
  scrape_results?: boolean
  sources?: unknown[]
  categories?: unknown[]
}

type FirecrawlSearchItem = {
  title: string
  url: string
  description?: string
  content?: string
  published?: string
  siteName?: string
}

type FirecrawlEntry = {
  url?: string
  sourceURL?: string
  sourceUrl?: string
  title?: string
  description?: string
  snippet?: string
  summary?: string
  markdown?: string
  content?: string
  text?: string
  publishedDate?: string
  published?: string
  metadata?: {
    sourceURL?: string
    title?: string
    publishedTime?: string
  }
}

type FirecrawlSearchResponse = {
  data?: unknown
  results?: unknown
  web?: { results?: unknown }
}

function resolveFirecrawlApiKey(runtime: FirecrawlRuntime) {
  return runtime?.firecrawl?.apiKey?.trim?.() || ''
}

function resolveFirecrawlBaseUrl(runtime: FirecrawlRuntime) {
  return (runtime?.firecrawl?.baseUrl?.trim?.() || DEFAULT_FIRECRAWL_BASE_URL).replace(/\/+$/, '')
}

function isOfficialFirecrawlEndpoint(url: URL) {
  return url.protocol === 'https:' && ALLOWED_FIRECRAWL_HOSTS.has(url.hostname)
}

async function resolveFirecrawlEndpoint(baseUrl: string) {
  const url = new URL(baseUrl || DEFAULT_FIRECRAWL_BASE_URL)
  const mode = isOfficialFirecrawlEndpoint(url)
    ? 'strict'
    : await validateSelfHostedBaseUrl(url.toString())
  url.pathname = '/v2/search'
  url.search = ''
  url.hash = ''
  return { url: url.toString(), mode }
}

function resolveSiteName(urlRaw: string) {
  try {
    return new URL(urlRaw).hostname.replace(/^www\./, '') || undefined
  } catch {
    return undefined
  }
}

function asFirecrawlEntry(value: unknown): FirecrawlEntry | null {
  if (!value || typeof value !== 'object') return null
  return value as FirecrawlEntry
}

function resolveSearchItems(payload: FirecrawlSearchResponse): FirecrawlSearchItem[] {
  const data =
    payload.data && typeof payload.data === 'object'
      ? (payload.data as Record<string, unknown>)
      : undefined
  const candidates = [
    payload.data,
    payload.results,
    data?.results,
    data?.data,
    data?.web,
    payload.web?.results
  ]
  const rawItems = candidates.find((c) => Array.isArray(c))
  if (!Array.isArray(rawItems)) return []

  const items: FirecrawlSearchItem[] = []
  for (const raw of rawItems) {
    const entry = asFirecrawlEntry(raw)
    if (!entry) continue
    const metadata =
      entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {}
    const href =
      entry.url || entry.sourceURL || entry.sourceUrl || metadata.sourceURL || ''
    if (!href) continue
    items.push({
      title: entry.title || metadata.title || '',
      url: href,
      description: entry.description || entry.snippet || entry.summary,
      content: entry.markdown || entry.content || entry.text,
      published: entry.publishedDate || entry.published || metadata.publishedTime,
      siteName: resolveSiteName(href)
    })
  }
  return items
}

export function missingFirecrawlApiKeyPayload() {
  return {
    error: 'missing_firecrawl_api_key',
    message: 'web_search (firecrawl) needs ai-workflow.crawl.webSearch.firecrawl.apiKey.',
    docs: 'docs/system-core.md'
  }
}

export async function runFirecrawlSearch(
  params: FirecrawlSearchParams,
  runtime: FirecrawlRuntime = {}
) {
  const apiKey = resolveFirecrawlApiKey(runtime)
  if (!apiKey) return missingFirecrawlApiKeyPayload()

  const query = String(params.query || '').trim()
  if (!query) throw new Error('query is required')

  const count =
    typeof params.count === 'number' && Number.isFinite(params.count)
      ? Math.max(1, Math.min(10, Math.floor(params.count)))
      : DEFAULT_SEARCH_COUNT
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)
  const scrapeResults = params.scrape_results === true
  const sources = Array.isArray(params.sources) ? params.sources.filter(Boolean) : []
  const categories = Array.isArray(params.categories) ? params.categories.filter(Boolean) : []
  const baseUrl = resolveFirecrawlBaseUrl(runtime)

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: 'firecrawl',
      q: query,
      count,
      baseUrl,
      sources,
      categories,
      scrapeResults
    })
  )
  const cached = readSearchCache(SEARCH_CACHE, cacheKey) as
    | { value: Record<string, unknown> }
    | null
    | undefined
  if (cached) return { ...cached.value, cached: true }

  const { url: endpoint, mode } = await resolveFirecrawlEndpoint(baseUrl)
  const body: Record<string, unknown> = { query, limit: count }
  if (sources.length) body.sources = sources
  if (categories.length) body.categories = categories
  if (scrapeResults) body.scrapeOptions = { formats: ['markdown'] }

  const withEndpoint =
    mode === 'selfHosted' ? withSelfHostedWebSearchEndpoint : withTrustedWebSearchEndpoint
  const start = Date.now()
  const data = await withEndpoint(
    {
      url: endpoint,
      timeoutSeconds,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    },
    async (res: Response) => {
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(
          `Firecrawl Search API error (${res.status}): ${detail || res.statusText}`
        )
      }
      return res.json() as Promise<FirecrawlSearchResponse>
    }
  )

  const items = resolveSearchItems(data)
  const payload = {
    query,
    provider: 'firecrawl',
    count: items.length,
    tookMs: Date.now() - start,
    externalContent: buildExternalSearchMeta('firecrawl'),
    results: items.map((entry) => ({
      title: entry.title ? wrapWebContent(entry.title, 'web_search') : '',
      url: entry.url,
      description: entry.description ? wrapWebContent(entry.description, 'web_search') : '',
      ...(entry.published ? { published: entry.published } : {}),
      ...(entry.siteName ? { siteName: entry.siteName } : {}),
      ...(scrapeResults && entry.content
        ? { content: wrapWebContent(entry.content, 'web_search') }
        : {})
    }))
  }

  writeSearchCache(SEARCH_CACHE, cacheKey, payload, cacheTtlMs)
  return payload
}
