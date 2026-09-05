/**
 */
import {
  DEFAULT_SEARCH_COUNT,
  buildExternalSearchMeta,
  buildSearchCacheKey,
  parseWebSearchTimeFilters,
  readCachedSearchPayload,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  writeCachedSearchPayload,
  wrapWebContent
} from './web-search-shared.js'
import { throwWebSearchApiError, withTrustedWebSearchEndpoint } from './web-search-endpoint.js'

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

const GEMINI_FRESHNESS_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 }

function toGeminiTimeRangeTimestamp(date: Date) {
  return date.toISOString().replace(/\.\d+Z$/, 'Z')
}

function resolveGeminiApiKey(runtime: Record<string, any>) {
  return runtime?.gemini?.apiKey?.trim?.() || ''
}

function resolveGeminiBaseUrl(runtime: Record<string, any>) {
  return (runtime?.gemini?.baseUrl?.trim?.() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '')
}

function resolveGeminiModel(runtime: Record<string, any>) {
  return runtime?.gemini?.model?.trim?.() || DEFAULT_GEMINI_MODEL
}

function resolveGeminiTimeRangeFilter(args: Record<string, any>) {
  const parsed = parseWebSearchTimeFilters({
    rawFreshness: args.freshness,
    rawDateAfter: args.date_after,
    rawDateBefore: args.date_before,
    freshnessProvider: 'perplexity'
  })
  if ('error' in parsed && parsed.error) return parsed

  const now = new Date()
  if (parsed.freshness) {
    const start = new Date(now)
    start.setUTCDate(start.getUTCDate() - GEMINI_FRESHNESS_DAYS[parsed.freshness])
    return {
      timeRangeFilter: {
        startTime: toGeminiTimeRangeTimestamp(start),
        endTime: toGeminiTimeRangeTimestamp(now)
      }
    }
  }
  if (!parsed.dateAfter && !parsed.dateBefore) return {}
  const end = parsed.dateBefore
    ? (() => {
        const d = new Date(`${parsed.dateBefore}T00:00:00Z`)
        d.setUTCDate(d.getUTCDate() + 1)
        return toGeminiTimeRangeTimestamp(d)
      })()
    : toGeminiTimeRangeTimestamp(now)
  return {
    timeRangeFilter: {
      startTime: parsed.dateAfter ? `${parsed.dateAfter}T00:00:00Z` : '1970-01-01T00:00:00Z',
      endTime: end
    }
  }
}

export function missingGeminiApiKeyPayload() {
  return {
    error: 'missing_gemini_api_key',
    message: 'web_search (gemini) needs GEMINI_API_KEY.',
    docs: 'docs/system-core.md'
  }
}

export async function runGeminiSearch(
  params: Record<string, any>,
  runtime: Record<string, any> = {}
) {
  if (params.country || params.language) {
    return {
      error: 'unsupported_filter',
      message: 'country/language filters are not supported by Gemini web_search.',
      provider: 'gemini'
    }
  }

  const apiKey = resolveGeminiApiKey(runtime)
  if (!apiKey) return missingGeminiApiKeyPayload()

  const query = String(params.query || '').trim()
  if (!query) throw new Error('query is required')

  const timeRange = resolveGeminiTimeRangeFilter(params) as any
  if (timeRange.error) return { error: timeRange.error, message: timeRange.message }

  const model = resolveGeminiModel(runtime)
  const baseUrl = resolveGeminiBaseUrl(runtime)
  const count = resolveSearchCount(params.count, runtime.maxResults ?? DEFAULT_SEARCH_COUNT)
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)

  const cacheKey = buildSearchCacheKey([
    'gemini',
    query,
    count,
    baseUrl,
    model,
    timeRange.timeRangeFilter?.startTime,
    timeRange.timeRangeFilter?.endTime
  ])
  const cached = readCachedSearchPayload(cacheKey)
  if (cached) return cached

  const endpoint = `${baseUrl}/models/${model}:generateContent`
  const googleSearch =
    timeRange.timeRangeFilter === undefined ? {} : { timeRangeFilter: timeRange.timeRangeFilter }

  const start = Date.now()
  const result = (await withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: query }] }],
          tools: [{ google_search: googleSearch }]
        })
      }
    },
    async (res: Response) => {
      if (!res.ok) await throwWebSearchApiError(res, 'Gemini API')
      const data = (await res.json()) as any
      if (data.error) {
        throw new Error(data.error.message || data.error.status || 'Gemini API error')
      }
      const candidate = data.candidates?.[0]
      const parts = candidate?.content?.parts
      const content = Array.isArray(parts)
        ? parts
            .map((p: any) => (typeof p.text === 'string' ? p.text : ''))
            .filter(Boolean)
            .join('\n')
        : ''
      if (!content) throw new Error('Gemini API error: empty response')

      const chunks = candidate?.groundingMetadata?.groundingChunks ?? []
      const citations = chunks
        .map((chunk: any) => {
          const web = chunk?.web
          if (!web || typeof web.uri !== 'string') return null
          return { url: web.uri, title: typeof web.title === 'string' ? web.title : undefined }
        })
        .filter(Boolean)

      return { content, citations }
    }
  )) as { content: string; citations: any[] }

  const payload = {
    query,
    provider: 'gemini',
    model,
    tookMs: Date.now() - start,
    externalContent: buildExternalSearchMeta('gemini'),
    content: wrapWebContent(result.content, 'web_search'),
    citations: result.citations
  }

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs)
  return payload
}
