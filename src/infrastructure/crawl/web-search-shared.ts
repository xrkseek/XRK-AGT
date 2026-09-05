/**
 */
import { wrapWebContent } from './web-fetch-executor.js'
import {
  DEFAULT_CACHE_MAX_ENTRIES,
  normalizeCacheKey,
  readTTLCache,
  writeTTLCache
} from './cache-utils.js'

export { wrapWebContent }

export { DEFAULT_CACHE_MAX_ENTRIES, normalizeCacheKey }
export const readSearchCache = readTTLCache
export const writeSearchCache = writeTTLCache

export const SEARCH_CACHE = new Map<string, any>()

export const DEFAULT_SEARCH_COUNT = 5
export const MAX_SEARCH_COUNT = 10
export const DEFAULT_SEARCH_TIMEOUT_SECONDS = 20
export const DEFAULT_SEARCH_CACHE_TTL_MINUTES = 15

export function buildSearchCacheKey(parts: unknown[]) {
  return normalizeCacheKey(
    parts
      .filter((p) => p !== undefined && p !== null && p !== '')
      .map(String)
      .join('|')
  )
}

export function readCachedSearchPayload(key: string) {
  const hit = readSearchCache(SEARCH_CACHE, key) as { value: Record<string, any> } | null | undefined
  return hit ? { ...hit.value, cached: true } : null
}

export function writeCachedSearchPayload(key: string, value: unknown, ttlMs: number) {
  writeSearchCache(SEARCH_CACHE, key, value, ttlMs)
}

const PERPLEXITY_FRESHNESS = new Set(['day', 'week', 'month', 'year'])
const GENERIC_FRESHNESS = new Set(['day', 'week', 'month', 'year', 'pd', 'pw', 'pm', 'py'])

export function normalizeFreshness(
  value: string | undefined,
  provider: 'perplexity' | 'exa' | 'generic' = 'generic'
) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
  if (!v) return undefined
  if (provider === 'perplexity') {
    return PERPLEXITY_FRESHNESS.has(v) ? v : undefined
  }
  if (provider === 'exa') {
    return PERPLEXITY_FRESHNESS.has(v) ? v : undefined
  }
  return GENERIC_FRESHNESS.has(v) ? v : undefined
}

export function normalizeToIsoDate(value: unknown) {
  return parseIsoDate(value)
}

/** MM/DD/YYYY for Perplexity Search API */
export function isoToPerplexityDate(isoDate: string) {
  const [y, m, d] = isoDate.split('-')
  return `${m}/${d}/${y}`
}

export function parseWebSearchTimeFilters(
  params: {
    rawFreshness?: string
    rawDateAfter?: string
    rawDateBefore?: string
    freshnessProvider?: 'perplexity' | 'exa'
  } = {}
) {
  const freshness = params.rawFreshness
    ? normalizeFreshness(params.rawFreshness, params.freshnessProvider ?? 'generic')
    : undefined
  if (params.rawFreshness && !freshness) {
    return { error: 'invalid_freshness', message: 'freshness must be day, week, month, or year.' }
  }
  if (freshness && (params.rawDateAfter || params.rawDateBefore)) {
    return {
      error: 'conflicting_time_filters',
      message: 'freshness and date_after/date_before cannot be used together.'
    }
  }
  const dateAfter = params.rawDateAfter ? parseIsoDate(params.rawDateAfter) : undefined
  if (params.rawDateAfter && !dateAfter) {
    return { error: 'invalid_date', message: 'date_after must be YYYY-MM-DD format.' }
  }
  const dateBefore = params.rawDateBefore ? parseIsoDate(params.rawDateBefore) : undefined
  if (params.rawDateBefore && !dateBefore) {
    return { error: 'invalid_date', message: 'date_before must be YYYY-MM-DD format.' }
  }
  if (dateAfter && dateBefore && dateAfter > dateBefore) {
    return { error: 'invalid_date_range', message: 'date_after must be on or before date_before.' }
  }
  return { freshness, dateAfter, dateBefore }
}

export function resolveSearchTimeoutSeconds(
  value: unknown,
  fallback = DEFAULT_SEARCH_TIMEOUT_SECONDS
) {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(1, Math.floor(parsed))
}

export function resolveSearchCacheTtlMs(
  value: unknown,
  fallbackMinutes = DEFAULT_SEARCH_CACHE_TTL_MINUTES
) {
  const minutes =
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallbackMinutes
  return Math.round(minutes * 60_000)
}

export function resolveSearchCount(value: unknown, fallback = DEFAULT_SEARCH_COUNT) {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)))
}

export function resolveSiteName(url: string | undefined | null) {
  if (!url) return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

const RECENCY_TO_BRAVE: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' }

export function normalizeBraveFreshness(value: unknown) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
  if (!v) return undefined
  if (['pd', 'pw', 'pm', 'py'].includes(v)) return v
  return RECENCY_TO_BRAVE[v] || v
}

export function parseIsoDate(value: unknown) {
  const trimmed = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined
  const [y, m, d] = trimmed.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return undefined
  }
  return trimmed
}

export function parseWebSearchDateRange(rawDateAfter?: string, rawDateBefore?: string) {
  const dateAfter = rawDateAfter ? parseIsoDate(rawDateAfter) : undefined
  if (rawDateAfter && !dateAfter) {
    return { error: 'invalid_date_after', message: 'date_after must be YYYY-MM-DD' }
  }
  const dateBefore = rawDateBefore ? parseIsoDate(rawDateBefore) : undefined
  if (rawDateBefore && !dateBefore) {
    return { error: 'invalid_date_before', message: 'date_before must be YYYY-MM-DD' }
  }
  if (dateAfter && dateBefore && dateAfter > dateBefore) {
    return { error: 'invalid_date_range', message: 'date_after must be on or before date_before' }
  }
  return { dateAfter, dateBefore }
}

export function buildExternalSearchMeta(provider: string) {
  return {
    untrusted: true,
    source: 'web_search',
    provider,
    wrapped: true
  }
}
