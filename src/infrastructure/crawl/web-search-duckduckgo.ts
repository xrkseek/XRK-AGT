/**
 */
import { fetchWithSsrFGuard } from './fetch-guard.js'
import {
  DEFAULT_SEARCH_COUNT,
  buildExternalSearchMeta,
  normalizeCacheKey,
  readSearchCache,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  writeSearchCache,
  wrapWebContent,
  SEARCH_CACHE
} from './web-search-shared.js'

const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html'
const DDG_SAFE_SEARCH_PARAM: Record<string, string> = { strict: '1', moderate: '-1', off: '-2' }
const DDG_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '--')
    .replace(/&hellip;/g, '...')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function stripHtml(html: string) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeDuckDuckGoUrl(rawUrl: string) {
  try {
    const normalized = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl
    const parsed = new URL(normalized)
    const uddg = parsed.searchParams.get('uddg')
    if (uddg) return uddg
  } catch {
    /* keep original */
  }
  return rawUrl
}

function readHrefAttribute(tagAttributes: string) {
  return /\bhref="([^"]*)"/i.exec(tagAttributes)?.[1] ?? ''
}

function isBotChallenge(html: string) {
  if (/class="[^"]*\bresult__a\b[^"]*"/i.test(html)) return false
  return /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html)
}

export function parseDuckDuckGoHtml(html: string) {
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const resultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi
  const nextResultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i
  const snippetRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i

  for (const match of html.matchAll(resultRegex)) {
    const rawAttributes = match[1] ?? ''
    const rawTitle = match[2] ?? ''
    const rawUrl = readHrefAttribute(rawAttributes)
    const matchEnd = (match.index ?? 0) + match[0].length
    const trailingHtml = html.slice(matchEnd)
    const nextResultIndex = trailingHtml.search(nextResultRegex)
    const scopedTrailingHtml =
      nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml
    const rawSnippet = snippetRegex.exec(scopedTrailingHtml)?.[1] ?? ''
    const title = decodeHtmlEntities(stripHtml(rawTitle))
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl))
    const snippet = decodeHtmlEntities(stripHtml(rawSnippet))
    if (title && url) results.push({ title, url, snippet })
  }
  return results
}

export async function runDuckDuckGoSearch(
  params: Record<string, any>,
  runtime: Record<string, any> = {}
) {
  const count = resolveSearchCount(params.count ?? runtime.maxResults, DEFAULT_SEARCH_COUNT)
  const region =
    typeof params.region === 'string'
      ? params.region.trim()
      : typeof runtime.region === 'string'
        ? runtime.region.trim()
        : ''
  const safeRaw = params.safeSearch ?? runtime.safeSearch
  const safeSearch = ['strict', 'moderate', 'off'].includes(safeRaw) ? safeRaw : 'moderate'
  const timeoutSeconds = resolveSearchTimeoutSeconds(params.timeoutSeconds ?? runtime.timeoutSeconds)
  const cacheTtlMs = resolveSearchCacheTtlMs(params.cacheTtlMinutes ?? runtime.cacheTtlMinutes)
  const cacheKey = normalizeCacheKey(
    JSON.stringify({ provider: 'duckduckgo', query: params.query, count, region, safeSearch })
  )
  const cached = readSearchCache(SEARCH_CACHE, cacheKey) as
    | { value: Record<string, any> }
    | null
    | undefined
  if (cached) return { ...cached.value, cached: true }

  const url = new URL(DDG_HTML_ENDPOINT)
  url.searchParams.set('q', params.query)
  if (region) url.searchParams.set('kl', region)
  url.searchParams.set('kp', DDG_SAFE_SEARCH_PARAM[safeSearch])

  const startedAt = Date.now()
  const { response } = await fetchWithSsrFGuard(
    url.toString(),
    {
      method: 'GET',
      headers: { 'User-Agent': DDG_USER_AGENT, Accept: 'text/html' }
    },
    { timeoutMs: timeoutSeconds * 1000, pinDns: true }
  )

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `DuckDuckGo search error (${response.status}): ${detail || response.statusText}`
    )
  }

  const html = await response.text()
  if (isBotChallenge(html)) {
    throw new Error('DuckDuckGo returned a bot-detection challenge.')
  }

  const parsed = parseDuckDuckGoHtml(html).slice(0, count)
  const payload = {
    query: params.query,
    provider: 'duckduckgo',
    count: parsed.length,
    tookMs: Date.now() - startedAt,
    externalContent: buildExternalSearchMeta('duckduckgo'),
    results: parsed.map((result) => ({
      title: wrapWebContent(result.title, 'web_search'),
      url: result.url,
      snippet: result.snippet ? wrapWebContent(result.snippet, 'web_search') : '',
      siteName: resolveSiteName(result.url) || undefined
    }))
  }

  writeSearchCache(SEARCH_CACHE, cacheKey, payload, cacheTtlMs)
  return payload
}
