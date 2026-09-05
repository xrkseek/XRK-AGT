/**
 * Parallel REST / MCP 共享归一化 — 移植 parallel-search-normalize.ts
 */
import {
  DEFAULT_SEARCH_COUNT,
  buildSearchCacheKey,
  resolveSiteName,
  wrapWebContent
} from './web-search-shared.js'

export const PARALLEL_MAX_SEARCH_COUNT = 40
export const PARALLEL_MAX_SEARCH_QUERY_CHARS = 200
export const PARALLEL_MAX_OBJECTIVE_CHARS = 5000
export const PARALLEL_MAX_SEARCH_QUERIES = 5
export const PARALLEL_SESSION_ID_MAX_LENGTH = 1000
export const PARALLEL_FREE_SESSION_ID_MAX_LENGTH = 100

export function resolveParallelSearchCount(value: unknown) {
  const parsed =
    typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_SEARCH_COUNT
  return Math.max(1, Math.min(PARALLEL_MAX_SEARCH_COUNT, parsed))
}

export function normalizeParallelObjective(value: unknown) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return undefined
  return trimmed.length <= PARALLEL_MAX_OBJECTIVE_CHARS
    ? trimmed
    : trimmed.slice(0, PARALLEL_MAX_OBJECTIVE_CHARS)
}

export function normalizeParallelSessionId(
  value: unknown,
  maxLength = PARALLEL_SESSION_ID_MAX_LENGTH
) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined
}

export function normalizeParallelSearchQueries(value: unknown) {
  const candidates = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of candidates) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    const capped =
      trimmed.length <= PARALLEL_MAX_SEARCH_QUERY_CHARS
        ? trimmed
        : trimmed.slice(0, PARALLEL_MAX_SEARCH_QUERY_CHARS)
    if (seen.has(capped)) continue
    seen.add(capped)
    out.push(capped)
    if (out.length >= PARALLEL_MAX_SEARCH_QUERIES) break
  }
  return out
}

export function invalidSearchQueriesPayload() {
  return {
    error: 'invalid_search_queries',
    message:
      'search_queries must be a non-empty array of keyword strings (max 5, max 200 chars each).',
    docs: 'docs/system-core.md'
  }
}

export function mapParallelResults(response: { results?: unknown } | null | undefined) {
  const raw = Array.isArray(response?.results) ? response.results : []
  return raw
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry: any) => {
      const title = typeof entry.title === 'string' ? entry.title : ''
      const url = typeof entry.url === 'string' ? entry.url : ''
      const published =
        typeof entry.publish_date === 'string' && entry.publish_date
          ? entry.publish_date
          : undefined
      const excerpts = Array.isArray(entry.excerpts)
        ? entry.excerpts
            .filter((e: unknown) => typeof e === 'string')
            .map((e: string) => wrapWebContent(e, 'web_search'))
        : []
      const description = excerpts.join('\n\n')
      return {
        title: title ? wrapWebContent(title, 'web_search') : '',
        url,
        description,
        snippet: description,
        siteName: resolveSiteName(url) || undefined,
        ...(published ? { published } : {}),
        ...(excerpts.length ? { excerpts } : {})
      }
    })
}

export function stripParallelGeneratedSessionId(payload: Record<string, any>) {
  if (!('sessionId' in payload)) return payload
  const { sessionId: _omit, ...rest } = payload
  return rest
}

export function buildParallelCacheKey(params: {
  provider?: string
  endpoint?: string
  objective?: string
  searchQueries: string[]
  count?: number
  sessionId?: string
  clientModel?: unknown
}) {
  return buildSearchCacheKey([
    params.provider ?? 'parallel',
    params.endpoint,
    params.objective,
    params.searchQueries.join('\u0000'),
    params.count,
    params.sessionId,
    params.clientModel
  ])
}

/** 从 query / search_queries 解析 Parallel 通用入参 */
export function resolveParallelSearchInput(params: Record<string, any>) {
  const objective = normalizeParallelObjective(params.objective)
  const cliQuery = normalizeParallelObjective(params.query)
  let searchQueries = normalizeParallelSearchQueries(params.search_queries)
  if (searchQueries.length === 0 && cliQuery) {
    searchQueries = normalizeParallelSearchQueries([cliQuery])
  }
  if (searchQueries.length === 0) {
    return { error: invalidSearchQueriesPayload() }
  }
  return { objective, searchQueries }
}
