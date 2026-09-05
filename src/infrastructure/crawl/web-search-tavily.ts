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
import { withTrustedWebSearchEndpoint } from './web-search-endpoint.js'

const DEFAULT_TAVILY_BASE_URL = 'https://api.tavily.com'

function resolveTavilyApiKey(runtime: Record<string, any>) {
  return runtime?.tavily?.apiKey?.trim?.() || ''
}

function resolveTavilyBaseUrl(runtime: Record<string, any>) {
  return (runtime?.tavily?.baseUrl?.trim?.() || DEFAULT_TAVILY_BASE_URL).replace(/\/+$/, '')
}

function resolveEndpoint(baseUrl: string, pathname: string) {
  try {
    const url = new URL(baseUrl)
    url.pathname = url.pathname.replace(/\/$/, '') + pathname
    return url.toString()
  } catch {
    return `${DEFAULT_TAVILY_BASE_URL}${pathname}`
  }
}

export function missingTavilyApiKeyPayload() {
  return {
    error: 'missing_tavily_api_key',
    message: 'web_search (tavily) needs ai-workflow.crawl.webSearch.tavily.apiKey.',
    docs: 'docs/system-core.md'
  }
}

export async function runTavilySearch(
  params: Record<string, any>,
  runtime: Record<string, any> = {}
) {
  const apiKey = resolveTavilyApiKey(runtime)
  if (!apiKey) return missingTavilyApiKeyPayload()

  const query = String(params.query || '').trim()
  if (!query) throw new Error('query is required')

  const count =
    typeof params.count === 'number' && Number.isFinite(params.count)
      ? Math.max(1, Math.min(20, Math.floor(params.count)))
      : DEFAULT_SEARCH_COUNT
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)
  const baseUrl = resolveTavilyBaseUrl(runtime)

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: 'tavily',
      q: query,
      count,
      baseUrl,
      searchDepth: params.search_depth,
      topic: params.topic,
      timeRange: params.time_range
    })
  )
  const cached = readSearchCache(SEARCH_CACHE, cacheKey) as
    | { value: Record<string, any> }
    | null
    | undefined
  if (cached) return { ...cached.value, cached: true }

  const body: Record<string, any> = { query, max_results: count, api_key: apiKey }
  if (params.search_depth) body.search_depth = params.search_depth
  if (params.topic) body.topic = params.topic
  if (params.include_answer) body.include_answer = true
  if (params.time_range) body.time_range = params.time_range
  if (Array.isArray(params.include_domains) && params.include_domains.length) {
    body.include_domains = params.include_domains
  }
  if (Array.isArray(params.exclude_domains) && params.exclude_domains.length) {
    body.exclude_domains = params.exclude_domains
  }

  const start = Date.now()
  const payload = (await withTrustedWebSearchEndpoint(
    {
      url: resolveEndpoint(baseUrl, '/search'),
      timeoutSeconds,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Source': 'xrk-agt'
        },
        body: JSON.stringify(body)
      }
    },
    async (res: Response) => {
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Tavily Search API error (${res.status}): ${detail || res.statusText}`)
      }
      return res.json()
    }
  )) as any

  const rawResults = Array.isArray(payload.results) ? payload.results : []
  const result = {
    query,
    provider: 'tavily',
    count: rawResults.length,
    tookMs: Date.now() - start,
    externalContent: buildExternalSearchMeta('tavily'),
    results: rawResults.map((r: any) => ({
      title: typeof r.title === 'string' ? wrapWebContent(r.title, 'web_search') : '',
      url: typeof r.url === 'string' ? r.url : '',
      snippet: typeof r.content === 'string' ? wrapWebContent(r.content, 'web_search') : '',
      score: typeof r.score === 'number' ? r.score : undefined,
      ...(typeof r.published_date === 'string' ? { published: r.published_date } : {})
    })),
    ...(typeof payload.answer === 'string' && payload.answer
      ? { answer: wrapWebContent(payload.answer, 'web_search') }
      : {})
  }

  writeSearchCache(SEARCH_CACHE, cacheKey, result, cacheTtlMs)
  return result
}
