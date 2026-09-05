/**
 */
import {
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  buildExternalSearchMeta,
  buildSearchCacheKey,
  isoToPerplexityDate,
  normalizeFreshness,
  normalizeToIsoDate,
  readCachedSearchPayload,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  writeCachedSearchPayload,
  wrapWebContent
} from './web-search-shared.js'
import { throwWebSearchApiError, withTrustedWebSearchEndpoint } from './web-search-endpoint.js'

export const DEFAULT_PERPLEXITY_BASE_URL = 'https://openrouter.ai/api/v1'
export const PERPLEXITY_DIRECT_BASE_URL = 'https://api.perplexity.ai'
const PERPLEXITY_SEARCH_ENDPOINT = 'https://api.perplexity.ai/search'
const DEFAULT_PERPLEXITY_MODEL = 'perplexity/sonar-pro'

function inferPerplexityBaseUrlFromApiKey(apiKey: string) {
  if (!apiKey) return undefined
  const n = apiKey.toLowerCase()
  if (n.startsWith('pplx-')) return 'direct'
  if (n.startsWith('sk-or-')) return 'openrouter'
  return undefined
}

export function isDirectPerplexityBaseUrl(baseUrl: string) {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase() === 'api.perplexity.ai'
  } catch {
    return false
  }
}

function resolvePerplexityApiKey(runtime: Record<string, any>) {
  const apiKey = runtime?.perplexity?.apiKey?.trim?.() || ''
  if (apiKey) return { apiKey, source: 'config' as const }
  const openRouterKey = runtime?.perplexity?.openRouterApiKey?.trim?.() || ''
  if (openRouterKey) return { apiKey: openRouterKey, source: 'openrouter_config' as const }
  return { apiKey: undefined as string | undefined, source: 'none' as const }
}

function resolvePerplexityBaseUrl(
  perplexity: Record<string, any>,
  auth: { apiKey?: string; source: string }
) {
  const fromConfig = perplexity?.baseUrl?.trim?.() || ''
  if (fromConfig) return fromConfig
  if (auth.source === 'openrouter_config') return DEFAULT_PERPLEXITY_BASE_URL
  if (auth.source === 'config') {
    return inferPerplexityBaseUrlFromApiKey(auth.apiKey || '') === 'openrouter'
      ? DEFAULT_PERPLEXITY_BASE_URL
      : PERPLEXITY_DIRECT_BASE_URL
  }
  return DEFAULT_PERPLEXITY_BASE_URL
}

function resolvePerplexityTransport(
  perplexity: Record<string, any>,
  auth: { apiKey?: string; source: string }
) {
  const baseUrl = resolvePerplexityBaseUrl(perplexity, auth)
  const model = perplexity?.model?.trim?.() || DEFAULT_PERPLEXITY_MODEL
  const hasLegacyOverride = Boolean(perplexity?.baseUrl?.trim?.() || perplexity?.model?.trim?.())
  const transport =
    hasLegacyOverride || !isDirectPerplexityBaseUrl(baseUrl) ? 'chat_completions' : 'search_api'
  return { ...auth, baseUrl, model, transport }
}

function resolvePerplexityRequestModel(baseUrl: string, model: string) {
  if (!isDirectPerplexityBaseUrl(baseUrl)) return model
  return model.startsWith('perplexity/') ? model.slice('perplexity/'.length) : model
}

function buildPerplexityHeaders(apiKey: string, acceptJson = false) {
  return {
    'Content-Type': 'application/json',
    ...(acceptJson ? { Accept: 'application/json' } : {}),
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://github.com/sunflowermm/XRK-AGT',
    'X-Title': 'XRK-AGT Web Search'
  }
}

function extractPerplexityCitations(data: any) {
  const top = Array.isArray(data.citations) ? data.citations.filter(Boolean) : []
  if (top.length) return [...new Set(top)]
  const citations: string[] = []
  for (const choice of data.choices ?? []) {
    for (const ann of choice.message?.annotations ?? []) {
      if (ann.type !== 'url_citation') continue
      const url = ann.url_citation?.url || ann.url
      if (typeof url === 'string' && url.trim()) citations.push(url.trim())
    }
  }
  return [...new Set(citations)]
}

async function runPerplexitySearchApi(params: Record<string, any>) {
  const body: Record<string, any> = { query: params.query, max_results: params.count }
  if (params.country) body.country = params.country
  if (params.searchDomainFilter?.length) body.search_domain_filter = params.searchDomainFilter
  if (params.searchRecencyFilter) body.search_recency_filter = params.searchRecencyFilter
  if (params.searchLanguageFilter?.length) body.search_language_filter = params.searchLanguageFilter
  if (params.searchAfterDate) body.search_after_date = params.searchAfterDate
  if (params.searchBeforeDate) body.search_before_date = params.searchBeforeDate
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens
  if (params.maxTokensPerPage !== undefined) body.max_tokens_per_page = params.maxTokensPerPage

  return withTrustedWebSearchEndpoint(
    {
      url: PERPLEXITY_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: 'POST',
        headers: buildPerplexityHeaders(params.apiKey, true),
        body: JSON.stringify(body)
      }
    },
    async (res: Response) => {
      if (!res.ok) await throwWebSearchApiError(res, 'Perplexity Search')
      const data = (await res.json()) as any
      return (data.results ?? []).map((entry: any) => ({
        title: entry.title ? wrapWebContent(entry.title, 'web_search') : '',
        url: entry.url ?? '',
        description: entry.snippet ? wrapWebContent(entry.snippet, 'web_search') : '',
        published: entry.date ?? undefined,
        siteName: resolveSiteName(entry.url) || undefined
      }))
    }
  )
}

async function runPerplexityChat(params: Record<string, any>) {
  const endpoint = `${params.baseUrl.replace(/\/$/, '')}/chat/completions`
  const body: Record<string, any> = {
    model: resolvePerplexityRequestModel(params.baseUrl, params.model),
    messages: [{ role: 'user', content: params.query }]
  }
  if (params.freshness) body.search_recency_filter = params.freshness

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: 'POST',
        headers: buildPerplexityHeaders(params.apiKey),
        body: JSON.stringify(body)
      }
    },
    async (res: Response) => {
      if (!res.ok) await throwWebSearchApiError(res, 'Perplexity')
      const data = (await res.json()) as any
      return {
        content: data.choices?.[0]?.message?.content ?? 'No response',
        citations: extractPerplexityCitations(data)
      }
    }
  )
}

export function missingPerplexityApiKeyPayload() {
  return {
    error: 'missing_perplexity_api_key',
    message:
      'web_search (perplexity) needs PERPLEXITY_API_KEY or OPENROUTER_API_KEY. Or use provider=duckduckgo (no key).',
    docs: 'docs/system-core.md'
  }
}

export async function runPerplexitySearch(
  params: Record<string, any>,
  runtime: Record<string, any> = {}
) {
  const perplexity = runtime.perplexity ?? {}
  const auth = resolvePerplexityApiKey(runtime)
  const rt = resolvePerplexityTransport(perplexity, auth)
  if (!rt.apiKey) return missingPerplexityApiKeyPayload()

  const query = String(params.query || '').trim()
  if (!query) throw new Error('query is required')

  const count = resolveSearchCount(params.count, runtime.maxResults ?? DEFAULT_SEARCH_COUNT)
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)

  const rawFreshness = params.freshness
  const freshness = rawFreshness ? normalizeFreshness(rawFreshness, 'perplexity') : undefined
  if (rawFreshness && !freshness) {
    return { error: 'invalid_freshness', message: 'freshness must be day, week, month, or year.' }
  }

  const structured = rt.transport === 'search_api'
  const country = typeof params.country === 'string' ? params.country.trim() : undefined
  const language = typeof params.language === 'string' ? params.language.trim() : undefined
  const domainFilter = Array.isArray(params.domain_filter)
    ? params.domain_filter.map(String)
    : undefined

  if (
    !structured &&
    (country || language || params.date_after || params.date_before || domainFilter?.length)
  ) {
    return {
      error: 'unsupported_filter',
      message:
        'country/language/date/domain filters require direct PERPLEXITY_API_KEY (Search API path).'
    }
  }
  if (language && !/^[a-z]{2}$/iu.test(language)) {
    return { error: 'invalid_language', message: 'language must be a 2-letter ISO 639-1 code.' }
  }

  const dateAfter = params.date_after ? normalizeToIsoDate(params.date_after) : undefined
  const dateBefore = params.date_before ? normalizeToIsoDate(params.date_before) : undefined
  if (params.date_after && !dateAfter) {
    return { error: 'invalid_date', message: 'date_after must be YYYY-MM-DD.' }
  }
  if (params.date_before && !dateBefore) {
    return { error: 'invalid_date', message: 'date_before must be YYYY-MM-DD.' }
  }

  const cacheKey = buildSearchCacheKey([
    'perplexity',
    rt.transport,
    rt.baseUrl,
    rt.model,
    query,
    count,
    country,
    language,
    freshness,
    dateAfter,
    dateBefore
  ])
  const cached = readCachedSearchPayload(cacheKey)
  if (cached) return cached

  const start = Date.now()
  let payload: Record<string, any>
  if (rt.transport === 'chat_completions') {
    const result = (await runPerplexityChat({
      query,
      apiKey: rt.apiKey,
      baseUrl: rt.baseUrl,
      model: rt.model,
      timeoutSeconds,
      freshness
    })) as { content: string; citations: string[] }
    payload = {
      query,
      provider: 'perplexity',
      model: rt.model,
      tookMs: Date.now() - start,
      externalContent: buildExternalSearchMeta('perplexity'),
      content: wrapWebContent(result.content, 'web_search'),
      citations: result.citations
    }
  } else {
    const results = (await runPerplexitySearchApi({
      query,
      apiKey: rt.apiKey,
      count: Math.min(count, MAX_SEARCH_COUNT),
      timeoutSeconds,
      country,
      searchDomainFilter: domainFilter,
      searchRecencyFilter: freshness,
      searchLanguageFilter: language ? [language] : undefined,
      searchAfterDate: dateAfter ? isoToPerplexityDate(dateAfter) : undefined,
      searchBeforeDate: dateBefore ? isoToPerplexityDate(dateBefore) : undefined,
      maxTokens: params.max_tokens,
      maxTokensPerPage: params.max_tokens_per_page
    })) as any[]
    payload = {
      query,
      provider: 'perplexity',
      count: results.length,
      tookMs: Date.now() - start,
      externalContent: buildExternalSearchMeta('perplexity'),
      results
    }
  }

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs)
  return payload
}
