/**
 * web-search runtime — 提供商解析 + runWebSearch + keyless 回退链
 */
import { resolveWebSearchConfig } from './crawl-config.js'
import { PARALLEL_MAX_SEARCH_COUNT } from './web-search-parallel-shared.js'
import { MAX_SEARCH_COUNT } from './web-search-shared.js'
import {
  getWebSearchProvider,
  listWebSearchProviderMeta,
  resolveAutoDetectProviderId,
  WEB_SEARCH_PROVIDERS
} from './web-search-registry.js'

/** ai-workflow.crawl.webSearch + overrides，并完成 provider auto-detect */
export function buildWebSearchRuntime(overrides: Record<string, any> = {}) {
  const base = resolveWebSearchConfig(overrides)
  const runtime = { ...base, ...overrides }

  if (!runtime.provider) {
    runtime.provider = resolveAutoDetectProviderId(runtime)
  } else if (!getWebSearchProvider(runtime.provider)) {
    runtime.provider = resolveAutoDetectProviderId(runtime)
  }

  return runtime
}

export function resolveWebSearchProviderId(runtime: Record<string, any> | null | undefined) {
  const id = String(runtime?.provider || '').toLowerCase()
  if (getWebSearchProvider(id)) return id
  return resolveAutoDetectProviderId(runtime ?? {})
}

export function listWebSearchProviders(runtime?: Record<string, any>) {
  return listWebSearchProviderMeta(runtime ?? buildWebSearchRuntime())
}

const PARALLEL_PROVIDER_IDS = new Set(['parallel', 'parallel-free'])

function clampSearchCount(count: number | undefined, providerId: string) {
  if (count === undefined) return undefined
  const cap = PARALLEL_PROVIDER_IDS.has(providerId) ? PARALLEL_MAX_SEARCH_COUNT : MAX_SEARCH_COUNT
  return Math.max(1, Math.min(cap, Math.floor(count)))
}

function normalizeSearchArgs(args: Record<string, any> = {}) {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) throw new Error('query is required')
  const count =
    typeof args.count === 'number' && Number.isFinite(args.count)
      ? Math.max(1, Math.floor(args.count))
      : undefined
  return { ...args, query, count }
}

async function dispatchProviderSearch(
  providerId: string,
  normalized: Record<string, any>,
  runtime: Record<string, any>
) {
  const entry = getWebSearchProvider(providerId)
  if (!entry) throw new Error(`Unknown web_search provider: ${providerId}`)
  const payload = { ...normalized, count: clampSearchCount(normalized.count, providerId) }
  return entry.run(payload, runtime)
}

const KEYLESS_FALLBACKS = ['parallel-free', 'duckduckgo']

async function runKeylessFallbackChain(
  normalized: Record<string, any>,
  runtime: Record<string, any>,
  fromProvider: string
) {
  for (const fallbackId of KEYLESS_FALLBACKS) {
    if (fallbackId === fromProvider) continue
    try {
      const fallbackResult = await dispatchProviderSearch(fallbackId, normalized, runtime)
      if (!fallbackResult?.error) {
        return { provider: fallbackId, result: fallbackResult, fallbackFrom: fromProvider }
      }
    } catch {
      /* 尝试下一 keyless 提供商 */
    }
  }
  return null
}

export async function runWebSearch(args: Record<string, any> = {}, runtime?: Record<string, any>) {
  const rt = runtime ?? buildWebSearchRuntime()
  if (rt.enabled === false) {
    throw new Error('web_search is disabled')
  }

  const normalized = normalizeSearchArgs(args)
  let providerId = resolveWebSearchProviderId(rt)
  const explicitProvider =
    typeof args.provider === 'string' && args.provider.trim()
      ? args.provider.trim().toLowerCase()
      : undefined
  if (explicitProvider && getWebSearchProvider(explicitProvider)) {
    providerId = explicitProvider
  }

  try {
    const result = await dispatchProviderSearch(providerId, normalized, rt)

    const shouldFallback =
      !explicitProvider &&
      (result?.error?.startsWith?.('missing_') || (result?.error && providerId !== 'duckduckgo'))

    if (shouldFallback) {
      const fb = await runKeylessFallbackChain(normalized, rt, providerId)
      if (fb) return fb
    }

    if (result?.error) {
      return { provider: providerId, result }
    }

    return { provider: providerId, result }
  } catch (e: any) {
    if (!explicitProvider) {
      const fb = await runKeylessFallbackChain(normalized, rt, providerId)
      if (fb) {
        return { ...fb, fallbackReason: e.message || String(e) }
      }
    }
    throw e
  }
}

export { WEB_SEARCH_PROVIDERS, getWebSearchProvider }
