/** redirect-headers.ts 移植 */

const CROSS_ORIGIN_REDIRECT_SAFE_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-language',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'pragma',
  'range',
  'user-agent',
]);

type HeadersInput = ConstructorParameters<typeof Headers>[0];

export function retainSafeHeadersForCrossOriginRedirect(
  headers: HeadersInput | null | undefined,
): Record<string, string> | HeadersInput | null | undefined {
  if (!headers) return headers;
  const incoming = new Headers(headers);
  const safe: Record<string, string> = {};
  for (const [key, value] of incoming.entries()) {
    if (CROSS_ORIGIN_REDIRECT_SAFE_HEADERS.has(key.toLowerCase())) {
      safe[key] = value;
    }
  }
  return safe;
}

export function dropBodyHeaders(
  headers: HeadersInput | null | undefined,
): Headers | HeadersInput | null | undefined {
  if (!headers) return headers;
  const next = new Headers(headers);
  for (const h of [
    'content-encoding',
    'content-language',
    'content-length',
    'content-location',
    'content-type',
    'transfer-encoding',
  ]) {
    next.delete(h);
  }
  return next;
}
