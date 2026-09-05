/** HTML 清洗、正文提取、markdown 转换 */
const READABILITY_MAX_HTML_CHARS = 1_000_000
const READABILITY_MAX_ESTIMATED_NESTING_DEPTH = 3_000

let readabilityDepsPromise: Promise<{
  Readability: any
  parseHTML: any
}> | null = null

function loadReadabilityDeps() {
  if (!readabilityDepsPromise) {
    readabilityDepsPromise = Promise.all([
      import('@mozilla/readability'),
      import('linkedom')
    ]).then(([readability, linkedom]) => ({
      Readability: (readability as any).Readability,
      parseHTML: (linkedom as any).parseHTML
    }))
  }
  return readabilityDepsPromise
}

const HIDDEN_STYLE_PATTERNS: Array<[string, RegExp]> = [
  ['display', /^\s*none\s*$/i],
  ['visibility', /^\s*hidden\s*$/i],
  ['opacity', /^\s*0\s*$/],
  ['font-size', /^\s*0(px|em|rem|pt|%)?\s*$/i],
  ['text-indent', /^\s*-\d{4,}px\s*$/],
  ['color', /^\s*transparent\s*$/i],
  ['color', /^\s*rgba\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
  ['color', /^\s*hsla\s*\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*0(?:\.0+)?\s*\)\s*$/i]
]

const HIDDEN_CLASS_NAMES = new Set([
  'sr-only',
  'visually-hidden',
  'd-none',
  'hidden',
  'invisible',
  'screen-reader-only',
  'offscreen'
])

const INVISIBLE_UNICODE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)))
}

function stripTags(value: string) {
  return decodeEntities(value.replace(/<[^>]+>/g, ''))
}

function hasHiddenClass(className: string) {
  return className
    .toLowerCase()
    .split(/\s+/)
    .some((cls) => HIDDEN_CLASS_NAMES.has(cls))
}

function isStyleHidden(style: string) {
  for (const [prop, pattern] of HIDDEN_STYLE_PATTERNS) {
    const escapedProp = prop.replace(/-/g, '\\-')
    const match = style.match(new RegExp(`(?:^|;)\\s*${escapedProp}\\s*:\\s*([^;]+)`, 'i'))
    if (match && pattern.test(match[1])) return true
  }
  const clipPath = style.match(/(?:^|;)\s*clip-path\s*:\s*([^;]+)/i)
  if (
    clipPath &&
    !/^\s*none\s*$/i.test(clipPath[1]) &&
    /inset\s*\(\s*(?:0*\.\d+|[1-9]\d*(?:\.\d+)?)%/i.test(clipPath[1])
  ) {
    return true
  }
  const transform = style.match(/(?:^|;)\s*transform\s*:\s*([^;]+)/i)
  if (transform) {
    if (/scale\s*\(\s*0\s*\)/i.test(transform[1])) return true
    if (/translateX\s*\(\s*-\d{4,}px\s*\)/i.test(transform[1])) return true
    if (/translateY\s*\(\s*-\d{4,}px\s*\)/i.test(transform[1])) return true
  }
  const width = style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i)
  const height = style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i)
  const overflow = style.match(/(?:^|;)\s*overflow\s*:\s*([^;]+)/i)
  if (
    width &&
    /^\s*0(px)?\s*$/i.test(width[1]) &&
    height &&
    /^\s*0(px)?\s*$/i.test(height[1]) &&
    overflow &&
    /^\s*hidden\s*$/i.test(overflow[1])
  ) {
    return true
  }
  const left = style.match(/(?:^|;)\s*left\s*:\s*([^;]+)/i)
  const top = style.match(/(?:^|;)\s*top\s*:\s*([^;]+)/i)
  if (left && /^\s*-\d{4,}px\s*$/i.test(left[1])) return true
  if (top && /^\s*-\d{4,}px\s*$/i.test(top[1])) return true
  return false
}

function shouldRemoveElement(element: any) {
  const tagName = String(element.tagName || '').toLowerCase()
  if (['meta', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed'].includes(tagName)) return true
  if (tagName === 'input' && element.getAttribute('type')?.toLowerCase() === 'hidden') return true
  if (element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('hidden')) return true
  if (hasHiddenClass(element.getAttribute('class') ?? '')) return true
  if (isStyleHidden(element.getAttribute('style') ?? '')) return true
  return false
}

export function stripInvisibleUnicode(text: string) {
  return text.replace(INVISIBLE_UNICODE_RE, '')
}

export async function sanitizeHtml(html: string) {
  const sanitized = html.replace(/<!--[\s\S]*?-->/g, '')
  const linkedom = await import('linkedom').catch(() => null)
  if (!linkedom) return sanitized
  const { document } = (linkedom as any).parseHTML(sanitized)
  const all = Array.from(document.querySelectorAll('*')) as any[]
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i]
    if (shouldRemoveElement(el)) el.parentNode?.removeChild(el)
  }
  return document.toString()
}

export function normalizeWhitespace(value: string) {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function htmlToMarkdown(html: string) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
  text = text.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, body) => {
      const label = normalizeWhitespace(stripTags(body))
      return label ? `[${label}](${href})` : href
    }
  )
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = '#'.repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))))
    return `\n${prefix} ${normalizeWhitespace(stripTags(body))}\n`
  })
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body))
    return label ? `\n- ${label}` : ''
  })
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, '\n')
  text = stripTags(text)
  return { text: normalizeWhitespace(text), title }
}

export function markdownToText(markdown: string) {
  let text = markdown
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, '')
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, '').replace(/```/g, '')
  )
  text = text.replace(/`([^`]+)`/g, '$1')
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+\.\s+/gm, '')
  return normalizeWhitespace(text)
}

export function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return { text: value, truncated: false }
  return { text: value.slice(0, maxChars), truncated: true }
}

function exceedsEstimatedHtmlNestingDepth(html: string, maxDepth: number) {
  const voidTags = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr'
  ])
  let depth = 0
  const len = html.length
  for (let i = 0; i < len; i++) {
    if (html.charCodeAt(i) !== 60) continue
    const next = html.charCodeAt(i + 1)
    if (next === 33 || next === 63) continue
    let j = i + 1
    let closing = false
    if (html.charCodeAt(j) === 47) {
      closing = true
      j += 1
    }
    while (j < len && html.charCodeAt(j) <= 32) j += 1
    const nameStart = j
    while (j < len) {
      const c = html.charCodeAt(j)
      if (
        !(
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) ||
          c === 58 ||
          c === 45
        )
      )
        break
      j += 1
    }
    const tagName = html.slice(nameStart, j).toLowerCase()
    if (!tagName) continue
    if (closing) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (voidTags.has(tagName)) continue
    let selfClosing = false
    for (let k = j; k < len && k < j + 200; k++) {
      if (html.charCodeAt(k) === 62) {
        if (html.charCodeAt(k - 1) === 47) selfClosing = true
        break
      }
    }
    if (selfClosing) continue
    depth += 1
    if (depth > maxDepth) return true
  }
  return false
}

export async function extractBasicHtmlContent(params: {
  html: string
  extractMode?: string
}) {
  const cleanHtml = await sanitizeHtml(params.html)
  const rendered = htmlToMarkdown(cleanHtml)
  if (params.extractMode === 'text') {
    const text =
      stripInvisibleUnicode(markdownToText(rendered.text)) ||
      stripInvisibleUnicode(normalizeWhitespace(stripTags(cleanHtml)))
    return text ? { text, title: rendered.title } : null
  }
  const text = stripInvisibleUnicode(rendered.text)
  return text ? { text, title: rendered.title } : null
}

export async function extractReadableContent(params: {
  html: string
  extractMode?: string
}) {
  const cleanHtml = await sanitizeHtml(params.html)
  if (
    cleanHtml.length > READABILITY_MAX_HTML_CHARS ||
    exceedsEstimatedHtmlNestingDepth(cleanHtml, READABILITY_MAX_ESTIMATED_NESTING_DEPTH)
  ) {
    return null
  }
  const deps = await loadReadabilityDeps().catch(() => null)
  if (!deps?.Readability || !deps?.parseHTML) return null
  const { Readability, parseHTML } = deps
  const { document } = parseHTML(cleanHtml)
  const parsed = new Readability(document, { charThreshold: 0 }).parse()
  if (!parsed?.content) return null
  const title = parsed.title || undefined
  if (params.extractMode === 'text') {
    const text = stripInvisibleUnicode(normalizeWhitespace(parsed.textContent ?? ''))
    return text ? { text, title } : null
  }
  const rendered = htmlToMarkdown(parsed.content)
  const text = stripInvisibleUnicode(rendered.text)
  return text ? { text, title: title ?? rendered.title } : null
}
