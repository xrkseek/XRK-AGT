/**
 */
import {
  buildExternalSearchMeta,
  readCachedSearchPayload,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  writeCachedSearchPayload
} from './web-search-shared.js'
import { withTrustedWebSearchEndpoint } from './web-search-endpoint.js'
import {
  buildParallelCacheKey,
  mapParallelResults,
  resolveParallelSearchCount,
  resolveParallelSearchInput
} from './web-search-parallel-shared.js'

export { normalizeParallelSearchQueries } from './web-search-parallel-shared.js'

const PARALLEL_BASE_URL = 'https://api.parallel.ai'
const PARALLEL_SEARCH_PATH = '/v1/search'

function resolveParallelApiKey(runtime: Record<string, any>) {
  return runtime?.parallel?.apiKey?.trim?.() || ''
}

function resolveParallelEndpoint(runtime: Record<string, any>) {
  const configured = runtime?.parallel?.baseUrl?.trim?.() || ''
  if (!configured) return `${PARALLEL_BASE_URL}${PARALLEL_SEARCH_PATH}`
  const candidate = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`
  const parsed = new URL(candidate)
  const pathname = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = pathname.endsWith(PARALLEL_SEARCH_PATH)
    ? pathname
    : `${pathname}${PARALLEL_SEARCH_PATH}`
  return parsed.toString()
}

export function missingParallelApiKeyPayload() {
  return {
    error: 'missing_parallel_api_key',
    message: 'web_search (parallel) needs PARALLEL_API_KEY.',
    docs: 'docs/system-core.md'
  }
}

export async function runParallelSearch(
  params: Record<string, any>,
  runtime: Record<string, any> = {}
) {
  const apiKey = resolveParallelApiKey(runtime)
  if (!apiKey) return missingParallelApiKeyPayload()

  const resolved = resolveParallelSearchInput(params)
  if ('error' in resolved && resolved.error) return resolved.error

  const { objective, searchQueries } = resolved as {
    objective?: string
    searchQueries: string[]
  }
  const count = resolveParallelSearchCount(params.count ?? runtime.maxResults)
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)
  const endpoint = resolveParallelEndpoint(runtime)

  const cacheKey = buildParallelCacheKey({
    provider: 'parallel',
    endpoint,
    objective,
    searchQueries,
    count,
    sessionId: params.session_id,
    clientModel: params.client_model
  })
  const cached = readCachedSearchPayload(cacheKey)
  if (cached) return cached

  const body: Record<string, any> = {
    search_queries: searchQueries,
    advanced_settings: { max_results: count }
  }
  if (objective) body.objective = objective
  if (params.session_id) body.session_id = String(params.session_id).slice(0, 1000)
  if (params.client_model) body.client_model = String(params.client_model).slice(0, 100)

  const start = Date.now()
  const response = (await withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds,
      init: {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'User-Agent': 'xrk-agt-parallel/1.0'
        },
        body: JSON.stringify(body)
      }
    },
    async (res: Response) => {
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Parallel API error (${res.status}): ${detail || res.statusText}`)
      }
      return res.json()
    }
  )) as any

  const results = mapParallelResults(response)
  const payload = {
    ...(objective ? { objective } : {}),
    searchQueries,
    provider: 'parallel',
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: buildExternalSearchMeta('parallel'),
    results,
    ...(typeof response.search_id === 'string' ? { searchId: response.search_id } : {}),
    ...(typeof response.session_id === 'string' ? { sessionId: response.session_id } : {}),
    ...(Array.isArray(response.warnings) && response.warnings.length
      ? { warnings: response.warnings }
      : {})
  }

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs)
  return payload
}
