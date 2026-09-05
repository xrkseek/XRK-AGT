/**
 * parallel-free — 免费 Search MCP（无需 API Key）
 * https://search.parallel.ai/mcp
 */
import { getWebSearchProviderScope } from './crawl-config.js'
import { randomUUID } from 'node:crypto'
import {
  buildExternalSearchMeta,
  readCachedSearchPayload,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  writeCachedSearchPayload
} from './web-search-shared.js'
import { callMcpTool } from './web-search-mcp-client.js'
import {
  PARALLEL_FREE_SESSION_ID_MAX_LENGTH,
  buildParallelCacheKey,
  mapParallelResults,
  normalizeParallelSessionId,
  resolveParallelSearchCount,
  resolveParallelSearchInput,
  stripParallelGeneratedSessionId
} from './web-search-parallel-shared.js'

export const PARALLEL_MCP_SEARCH_URL = 'https://search.parallel.ai/mcp'

function normalizeMcpSessionId(value: unknown) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || randomUUID()
}

export async function runParallelFreeSearch(
  params: Record<string, any>,
  runtime: Record<string, any> = {}
) {
  const resolved = resolveParallelSearchInput(params)
  if ('error' in resolved && resolved.error) return resolved.error

  const { objective, searchQueries } = resolved as {
    objective?: string
    searchQueries: string[]
  }
  const count = resolveParallelSearchCount(params.count ?? runtime.maxResults)
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)
  const mcpUrl =
    getWebSearchProviderScope(runtime, 'parallel-free')?.url?.trim?.() || PARALLEL_MCP_SEARCH_URL

  const sessionId = normalizeMcpSessionId(
    normalizeParallelSessionId(params.session_id, PARALLEL_FREE_SESSION_ID_MAX_LENGTH)
  )

  const cacheKey = buildParallelCacheKey({
    provider: 'parallel-free',
    endpoint: mcpUrl,
    objective,
    searchQueries,
    count,
    sessionId: params.session_id ? sessionId : undefined,
    clientModel: params.client_model
  })
  const cached = readCachedSearchPayload(cacheKey)
  if (cached) return cached

  const toolArgs: Record<string, any> = {
    objective: objective ?? searchQueries.join(' '),
    search_queries: [...searchQueries],
    session_id: sessionId
  }
  if (params.client_model) toolArgs.model_name = String(params.client_model).slice(0, 100)

  const start = Date.now()
  const payload = await callMcpTool({
    url: mcpUrl,
    toolName: 'web_search',
    toolArgs,
    timeoutSeconds,
    clientName: 'xrk-agt-parallel-free'
  })

  const allResults = Array.isArray(payload.results) ? payload.results : []
  const results = mapParallelResults({ results: allResults.slice(0, Math.max(count, 1)) })

  const out: Record<string, any> = {
    ...(objective ? { objective } : {}),
    searchQueries,
    provider: 'parallel-free',
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: buildExternalSearchMeta('parallel-free'),
    results,
    ...(typeof payload.search_id === 'string' ? { searchId: payload.search_id } : {}),
    sessionId,
    ...(Array.isArray(payload.warnings) && payload.warnings.length
      ? { warnings: payload.warnings }
      : {})
  }

  const cachePayload = params.session_id ? out : stripParallelGeneratedSessionId(out)
  writeCachedSearchPayload(cacheKey, cachePayload, cacheTtlMs)
  return out
}
