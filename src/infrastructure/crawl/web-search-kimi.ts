/**
 */
import {
  buildExternalSearchMeta,
  buildSearchCacheKey,
  readCachedSearchPayload,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  writeCachedSearchPayload,
  wrapWebContent
} from './web-search-shared.js'
import { throwWebSearchApiError, withTrustedWebSearchEndpoint } from './web-search-endpoint.js'

const DEFAULT_KIMI_BASE_URL = 'https://api.moonshot.cn/v1'
const DEFAULT_KIMI_MODEL = 'moonshot-v1-8k'
const KIMI_WEB_SEARCH_TOOL = { type: 'builtin_function', function: { name: '$web_search' } }
const KIMI_THINKING_MODELS = new Set(['kimi-k2.6', 'kimi-k2.5'])

type KimiRuntime = {
  kimi?: { apiKey?: string; baseUrl?: string; model?: string }
  timeoutSeconds?: number
  cacheTtlMinutes?: number
}

type KimiSearchParams = {
  query?: string
}

type KimiToolCall = {
  id?: string
  function?: { name?: string; arguments?: string }
}

type KimiMessage = {
  role: string
  content?: string
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: KimiToolCall[]
}

type KimiChatResponse = {
  search_results?: Array<{ url?: unknown }>
  choices?: Array<{
    finish_reason?: string
    message?: KimiMessage
  }>
}

function resolveKimiApiKey(runtime: KimiRuntime) {
  return runtime?.kimi?.apiKey?.trim?.() || ''
}

function resolveKimiBaseUrl(runtime: KimiRuntime) {
  return (runtime?.kimi?.baseUrl?.trim?.() || DEFAULT_KIMI_BASE_URL).replace(/\/+$/, '')
}

function resolveKimiModel(runtime: KimiRuntime) {
  return runtime?.kimi?.model?.trim?.() || DEFAULT_KIMI_MODEL
}

function extractKimiCitations(data: KimiChatResponse) {
  const citations: string[] = []
  for (const entry of data.search_results ?? []) {
    if (entry?.url && typeof entry.url === 'string') citations.push(entry.url.trim())
  }
  const toolCalls = data.choices?.[0]?.message?.tool_calls ?? []
  for (const toolCall of toolCalls) {
    const raw = toolCall?.function?.arguments
    if (typeof raw !== 'string' || !raw) continue
    try {
      const parsed = JSON.parse(raw) as {
        url?: unknown
        search_results?: Array<{ url?: unknown }>
      }
      if (parsed.url) citations.push(String(parsed.url))
      for (const r of parsed.search_results ?? []) {
        if (r?.url) citations.push(String(r.url))
      }
    } catch {
      /* ignore */
    }
  }
  return [...new Set(citations.filter(Boolean))]
}

export function missingKimiApiKeyPayload() {
  return {
    error: 'missing_kimi_api_key',
    message: 'web_search (kimi) needs KIMI_API_KEY or MOONSHOT_API_KEY.',
    docs: 'docs/system-core.md'
  }
}

export async function runKimiSearch(params: KimiSearchParams, runtime: KimiRuntime = {}) {
  const apiKey = resolveKimiApiKey(runtime)
  if (!apiKey) return missingKimiApiKeyPayload()

  const query = String(params.query || '').trim()
  if (!query) throw new Error('query is required')

  const model = resolveKimiModel(runtime)
  const baseUrl = resolveKimiBaseUrl(runtime)
  const timeoutSeconds = resolveSearchTimeoutSeconds(runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(runtime.cacheTtlMinutes)

  const cacheKey = buildSearchCacheKey(['kimi', baseUrl, model, query])
  const cached = readCachedSearchPayload(cacheKey)
  if (cached) return cached

  const endpoint = `${baseUrl}/chat/completions`
  const messages: KimiMessage[] = [{ role: 'user', content: query }]
  const collectedCitations = new Set<string>()
  let content = ''
  const start = Date.now()

  for (let round = 0; round < 3; round += 1) {
    const data = await withTrustedWebSearchEndpoint(
      {
        url: endpoint,
        timeoutSeconds,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            ...(KIMI_THINKING_MODELS.has(model) ? { thinking: { type: 'disabled' } } : {}),
            messages,
            tools: [KIMI_WEB_SEARCH_TOOL]
          })
        }
      },
      async (res: Response) => {
        if (!res.ok) await throwWebSearchApiError(res, 'Kimi API')
        return res.json() as Promise<KimiChatResponse>
      }
    )

    for (const c of extractKimiCitations(data)) collectedCitations.add(c)

    const choice = data.choices?.[0]
    const message = choice?.message
    const text = message?.content?.trim?.() || message?.reasoning_content?.trim?.() || ''
    const toolCalls = message?.tool_calls ?? []

    if (choice?.finish_reason !== 'tool_calls' || !toolCalls.length) {
      content = text || content
      break
    }

    if (message) messages.push(message)
    for (const toolCall of toolCalls) {
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolCall.function?.arguments || '{}'
      })
    }
  }

  const payload = {
    query,
    provider: 'kimi',
    model,
    tookMs: Date.now() - start,
    externalContent: buildExternalSearchMeta('kimi'),
    content: wrapWebContent(content || 'No response', 'web_search'),
    citations: [...collectedCitations]
  }

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs)
  return payload
}
