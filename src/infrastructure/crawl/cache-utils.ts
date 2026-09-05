export const DEFAULT_CACHE_MAX_ENTRIES = 100;

type TTLCacheEntry = {
  value: unknown;
  expiresAt: number;
  insertedAt: number;
};

export function normalizeCacheKey(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

export function readTTLCache(
  cache: Map<string, TTLCacheEntry>,
  key: string,
): { value: unknown; cached: true } | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) cache.delete(key);
    return null;
  }
  return { value: entry.value, cached: true };
}

export function writeTTLCache(
  cache: Map<string, TTLCacheEntry>,
  key: string,
  value: unknown,
  ttlMs: number,
  maxEntries: number = DEFAULT_CACHE_MAX_ENTRIES,
): void {
  if (ttlMs <= 0) return;
  if (cache.size >= maxEntries) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs, insertedAt: Date.now() });
}
