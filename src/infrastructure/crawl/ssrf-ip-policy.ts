/**
 */
import net from 'node:net'

export function normalizeHostname(hostname: unknown): string {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '')
}

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

export function isCanonicalDottedDecimalIPv4(value: string): boolean {
  const n = ipv4ToUint32(value)
  if (n === null) return false
  const parts = value.split('.')
  return parts.every((p) => /^[0-9]+$/.test(p) && String(Number(p)) === p)
}

/** 八进制/十六进制/十进制混写等 legacy IPv4 字面量 */
export function isLegacyIpv4Literal(value: unknown): boolean {
  const v = String(value || '').trim()
  if (!v.includes('.') && !v.startsWith('0x')) return false
  if (isCanonicalDottedDecimalIPv4(v)) return false
  const parts = v.split('.')
  if (parts.length < 1 || parts.length > 4) return false
  return parts.every((part) => {
    if (!part.length) return false
    if (/^0x[0-9a-f]+$/i.test(part)) return true
    if (/^0[0-7]+$/.test(part)) return true
    return /^[0-9]+$/.test(part)
  })
}

function looksLikeUnsupportedIpv4Literal(address: string): boolean {
  const parts = address.split('.')
  if (parts.length === 0 || parts.length > 4) return false
  if (parts.some((part) => part.length === 0)) return true
  return parts.every((part) => /^[0-9]+$/.test(part) || /^0x/i.test(part))
}

export function isIpv4Address(ip: string): boolean {
  return net.isIPv4(ip)
}

export function isBlockedSpecialUseIpv4Address(
  ip: string,
  options: { allowRfc2544BenchmarkRange?: boolean } = {}
): boolean {
  const n = ipv4ToUint32(ip)
  if (n === null) return true
  const a = n >>> 24
  const b = (n >>> 16) & 255
  if (a === 0) return true
  if (a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (!options.allowRfc2544BenchmarkRange && a === 198 && b >= 18 && b <= 19) return true
  return false
}

export function isBlockedSpecialUseIpv6Address(
  ip: string,
  options: { allowUniqueLocalRange?: boolean } = {}
): boolean {
  const x = ip.toLowerCase().trim()
  if (x === '::1' || x === '::') return true
  if (x.startsWith('fe80:')) return true
  if (x.startsWith('fc') || x.startsWith('fd')) {
    return !options.allowUniqueLocalRange
  }
  if (/^fe[89ab][0-9a-f]:/i.test(x)) return true
  const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (m) return isBlockedSpecialUseIpv4Address(m[1])
  return false
}

export function extractEmbeddedIpv4FromIpv6(ip: string): string | null {
  const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return m ? m[1] : null
}

export function isLinkLocalIpAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const n = ipv4ToUint32(address)
    if (n === null) return false
    const a = n >>> 24
    const b = (n >>> 16) & 255
    return a === 169 && b === 254
  }
  return address.toLowerCase().startsWith('fe80:')
}

export function isCloudMetadataIpAddress(address: string): boolean {
  return address === '169.254.169.254'
}

export function parseLooseIpAddress(value: string): string | null {
  if (net.isIP(value)) return value
  return null
}

export function parseCanonicalIpAddress(value: unknown): string | null {
  const n = normalizeHostname(value)
  if (!n) return null
  if (net.isIP(n)) return n
  if (isCanonicalDottedDecimalIPv4(n)) return n
  return null
}

export function isPrivateIpAddress(
  address: unknown,
  policy: {
    allowRfc2544BenchmarkRange?: boolean
    allowIpv6UniqueLocalRange?: boolean
  } = {}
): boolean {
  const normalized = normalizeHostname(address)
  if (!normalized) return false

  const v4Opts = { allowRfc2544BenchmarkRange: policy.allowRfc2544BenchmarkRange === true }
  const v6Opts = { allowUniqueLocalRange: policy.allowIpv6UniqueLocalRange === true }

  const strict = parseCanonicalIpAddress(normalized)
  if (strict) {
    if (isIpv4Address(strict)) return isBlockedSpecialUseIpv4Address(strict, v4Opts)
    if (isBlockedSpecialUseIpv6Address(strict, v6Opts)) return true
    const embedded = extractEmbeddedIpv4FromIpv6(strict)
    if (embedded) return isBlockedSpecialUseIpv4Address(embedded, v4Opts)
    return false
  }

  if (normalized.includes(':') && !parseLooseIpAddress(normalized)) return true
  if (!isCanonicalDottedDecimalIPv4(normalized) && isLegacyIpv4Literal(normalized)) return true
  if (looksLikeUnsupportedIpv4Literal(normalized)) return true
  return false
}
