/**
 */
import { fetchWithSsrFGuard } from './fetch-guard.js'
import {
  DEFAULT_SEARCH_COUNT,
  buildExternalSearchMeta,
  resolveSearchCount,
  resolveSiteName,
  wrapWebContent
} from './web-search-shared.js'
import { normalizeError } from '#utils/normalize-error.js'

const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434'
const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com'
const OLLAMA_HOSTED_PATH = '/api/web_search'
const OLLAMA_LOCAL_PROXY_PATH = '/api/experimental/web_search'
const DEFAULT_TIMEOUT_MS = 15_000
const SNIPPET_MAX = 300

type OllamaRuntime = {
  ollama?: { baseUrl?: string; apiKey?: string; cloudApiKey?: string }
  maxResults?: number
}

type OllamaSearchParams = {
  query?: string
  count?: number
}

type OllamaResultEntry = {
  title?: unknown
  url?: unknown
  content?: unknown
}

type OllamaSearchResponse = {
  results?: OllamaResultEntry[]
}

function resolveOllamaBaseUrl(runtime: OllamaRuntime) {
  return (runtime?.ollama?.baseUrl?.trim?.() || OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function resolveOllamaApiKey(runtime: OllamaRuntime) {
  return runtime?.ollama?.apiKey?.trim?.() || ''
}

function isOllamaCloudBaseUrl(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl)
    return parsed.protocol === 'https:' && parsed.hostname === 'ollama.com'
  } catch {
    return false
  }
}

function buildOllamaAttempts(baseUrl: string, runtime: OllamaRuntime) {
  const apiKey = resolveOllamaApiKey(runtime)
  if (isOllamaCloudBaseUrl(baseUrl)) {
    return [{ baseUrl, path: OLLAMA_HOSTED_PATH, apiKey }]
  }
  const attempts = [
    { baseUrl, path: OLLAMA_LOCAL_PROXY_PATH, apiKey },
    { baseUrl, path: OLLAMA_HOSTED_PATH, apiKey }
  ]
  const cloudKey = runtime?.ollama?.cloudApiKey?.trim?.() || ''
  if (cloudKey) {
    attempts.push({ baseUrl: OLLAMA_CLOUD_BASE_URL, path: OLLAMA_HOSTED_PATH, apiKey: cloudKey })
  }
  return attempts
}

function truncateSnippet(text: string) {
  if (!text || text.length <= SNIPPET_MAX) return text
  return `${text.slice(0, SNIPPET_MAX)}…`
}

function isOllamaResultEntry(r: unknown): r is OllamaResultEntry & { url: string } {
  return Boolean(
    r &&
      typeof r === 'object' &&
      typeof (r as OllamaResultEntry).url === 'string' &&
      ((r as OllamaResultEntry).url as string).trim()
  )
}

export async function runOllamaSearch(
  params: OllamaSearchParams,
  runtime: OllamaRuntime = {}
) {
  const query = String(params.query || '').trim()
  if (!query) throw new Error('query is required')

  const baseUrl = resolveOllamaBaseUrl(runtime)
  const count = resolveSearchCount(params.count, runtime.maxResults ?? DEFAULT_SEARCH_COUNT)
  const startedAt = Date.now()
  const body = JSON.stringify({ query, max_results: count })
  const attempts = buildOllamaAttempts(baseUrl, runtime)

  let payload: OllamaSearchResponse | undefined
  let lastError: Error | undefined
  for (const attempt of attempts) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (attempt.apiKey) headers.Authorization = `Bearer ${attempt.apiKey}`

    try {
      const { response } = await fetchWithSsrFGuard(
        `${attempt.baseUrl}${attempt.path}`,
        {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
        },
        {
          maxRedirects: 0,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          ssrfPolicy: { allowPrivateNetwork: true },
          pinDns: false
        }
      )

      if (response.status === 401) {
        throw new Error('Ollama web search authentication failed. Run `ollama signin`.')
      }
      if (response.status === 403) {
        throw new Error('Ollama web search unavailable on this host.')
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const message = `Ollama web search failed (${response.status}): ${detail}`.trim()
        if (response.status === 404) {
          lastError = new Error(message)
          continue
        }
        throw new Error(message)
      }
      payload = (await response.json()) as OllamaSearchResponse
      break
    } catch (err) {
      lastError = normalizeError(err)
      if (attempt === attempts[attempts.length - 1]) throw lastError
    }
  }

  if (!payload) throw lastError ?? new Error('Ollama web search failed')

  const results = Array.isArray(payload.results)
    ? payload.results.filter(isOllamaResultEntry).slice(0, count)
    : []

  return {
    query,
    provider: 'ollama',
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: buildExternalSearchMeta('ollama'),
    results: results.map((result) => {
      const snippet = truncateSnippet(typeof result.content === 'string' ? result.content : '')
      return {
        title: result.title ? wrapWebContent(String(result.title), 'web_search') : '',
        url: result.url,
        snippet: snippet ? wrapWebContent(snippet, 'web_search') : '',
        siteName: resolveSiteName(result.url) || undefined
      }
    })
  }
}
