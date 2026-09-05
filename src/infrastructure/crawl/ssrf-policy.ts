/**
 */
import dns from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, ProxyAgent } from 'undici';
import {
  isCloudMetadataIpAddress,
  isLinkLocalIpAddress,
  isPrivateIpAddress,
  normalizeHostname
} from './ssrf-ip-policy.js';

export class SsrFBlockedError extends Error {
  constructor(message: any) {
    super(message);
    this.name = 'SsrFBlockedError';
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal'];
const DISPATCHER_CLOSE_TIMEOUT_MS = 100;

export function isPrivateNetworkAllowedByPolicy(policy: any) {
  return policy?.dangerouslyAllowPrivateNetwork === true || policy?.allowPrivateNetwork === true;
}

export function normalizeHostnameAllowlist(values: any) {
  if (!Array.isArray(values)) return [];
  const out = new Set();
  for (const raw of values) {
    const n = normalizeHostname(raw);
    if (n && n !== '*' && n !== '*.') out.add(n);
  }
  return [...out];
}

export function isHostnameAllowedByPattern(hostname: any, pattern: any) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    if (!suffix || hostname === suffix) return false;
    return hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

export function matchesHostnameAllowlist(hostname: any, allowlist: any) {
  if (!allowlist?.length) return true;
  return allowlist.some((pattern: any) => isHostnameAllowedByPattern(hostname, pattern));
}

export function mergeSsrFPolicies(...policies: any[]) {
  const merged: Record<string, any> = {};
  for (const policy of policies) {
    if (!policy) continue;
    if (policy.allowPrivateNetwork) merged.allowPrivateNetwork = true;
    if (policy.dangerouslyAllowPrivateNetwork) merged.dangerouslyAllowPrivateNetwork = true;
    if (policy.allowRfc2544BenchmarkRange) merged.allowRfc2544BenchmarkRange = true;
    if (policy.allowIpv6UniqueLocalRange) merged.allowIpv6UniqueLocalRange = true;
    if (policy.allowedHostnames?.length) {
      merged.allowedHostnames = [...new Set([...(merged.allowedHostnames ?? []), ...policy.allowedHostnames])];
    }
    if (policy.allowedOrigins?.length) {
      merged.allowedOrigins = [...new Set([...(merged.allowedOrigins ?? []), ...policy.allowedOrigins])];
    }
    if (policy.hostnameAllowlist?.length) {
      merged.hostnameAllowlist = [...new Set([...(merged.hostnameAllowlist ?? []), ...policy.hostnameAllowlist])];
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeOrigin(value: any) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    parsed.hostname = parsed.hostname.replace(/\.+$/, '');
    return parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

export function resolveSsrFPolicyForUrl(url: any, policy: any) {
  if (!policy?.allowedOrigins?.length) return policy;
  const requestOrigin = normalizeOrigin(url.toString());
  const allowed = (policy.allowedOrigins || []).map(normalizeOrigin).filter(Boolean);
  if (!requestOrigin || !allowed.includes(requestOrigin)) return policy;
  return {
    ...policy,
    allowedHostnames: [...new Set([...(policy.allowedHostnames ?? []), normalizeHostname(url.hostname)])]
  };
}

function isBlockedHostnameNormalized(normalized: any) {
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  return BLOCKED_SUFFIXES.some((s: any) => normalized.endsWith(s));
}

export function isBlockedHostnameOrIp(hostnameOrIp: any, policy: any) {
  const normalized = normalizeHostname(hostnameOrIp);
  if (!normalized) return false;
  if (isBlockedHostnameNormalized(normalized)) return true;
  return isPrivateIpAddress(normalized, policy);
}

function shouldSkipPrivateNetworkChecks(hostname: any, policy: any) {
  if (isPrivateNetworkAllowedByPolicy(policy)) return true;
  const allowed = new Set((policy?.allowedHostnames ?? []).map(normalizeHostname));
  return allowed.has(hostname);
}

function resolveHostnamePolicyChecks(hostname: any, policy: any) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) throw new Error('Invalid hostname');

  const hostnameAllowlist = normalizeHostnameAllowlist(policy?.hostnameAllowlist);
  const skipPrivateNetworkChecks = shouldSkipPrivateNetworkChecks(normalized, policy);

  if (!matchesHostnameAllowlist(normalized, hostnameAllowlist)) {
    throw new SsrFBlockedError(`Blocked hostname (not in allowlist): ${hostname}`);
  }
  if (!skipPrivateNetworkChecks && isBlockedHostnameOrIp(normalized, policy)) {
    throw new SsrFBlockedError('Blocked hostname or private/internal/special-use IP address');
  }
  return { normalized, skipPrivateNetworkChecks };
}

function assertAllowedResolvedAddresses(results: any, policy: any) {
  for (const entry of results) {
    if (isBlockedHostnameOrIp(entry.address, policy)) {
      throw new SsrFBlockedError('Blocked: resolves to private/internal/special-use IP address');
    }
  }
}

function assertAllowedTrustedHostnameResolvedAddresses(results: any) {
  for (const entry of results) {
    if (isLinkLocalIpAddress(entry.address) || isCloudMetadataIpAddress(entry.address)) {
      throw new SsrFBlockedError('Blocked: resolves to private/internal/special-use IP address');
    }
  }
}

function dedupeAndPreferIpv4(results: any) {
  const seen = new Set();
  const ipv4 = [];
  const other = [];
  for (const entry of results) {
    if (seen.has(entry.address)) continue;
    seen.add(entry.address);
    if (entry.family === 4) ipv4.push(entry.address);
    else other.push(entry.address);
  }
  return [...ipv4, ...other];
}

export function createPinnedLookup({ hostname, addresses, fallback }: any) {
  const normalizedHost = normalizeHostname(hostname);
  const records = addresses.map((address: any) => ({ address, family: address.includes(':') ? 6 : 4 }));
  const ipv4Records = records.filter((e: any) => e.family === 4);
  const automaticRecords = ipv4Records.length > 0 ? ipv4Records : records;
  let index = 0;
  const fb = fallback ?? dns.lookup;

  return (host: any, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    if (!cb) return;
    const normalized = normalizeHostname(host);
    if (!normalized || normalized !== normalizedHost) {
      if (typeof options === 'function' || options === undefined) return fb(host, cb);
      return fb(host, options, cb);
    }
    const opts = typeof options === 'object' && options !== null ? options : {};
    const requestedFamily =
      typeof options === 'number' ? options : typeof opts.family === 'number' ? opts.family : 0;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((e: any) => e.family === requestedFamily)
        : automaticRecords;
    const usable = candidates.length > 0 ? candidates : automaticRecords;
    if (opts.all) {
      cb(null, usable);
      return;
    }
    const chosen = usable[index % usable.length];
    index += 1;
    cb(null, chosen.address, chosen.family);
  };
}

export async function resolvePinnedHostnameWithPolicy(hostname: any, params: any = {}) {
  const { normalized, skipPrivateNetworkChecks } = resolveHostnamePolicyChecks(hostname, params.policy);
  const lookupFn = params.lookupFn ?? dnsLookup;
  const results = await lookupFn(normalized, { all: true });
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`Unable to resolve hostname: ${hostname}`);
  }
  if (!skipPrivateNetworkChecks) {
    assertAllowedResolvedAddresses(results, params.policy);
  } else if (!isPrivateNetworkAllowedByPolicy(params.policy)) {
    assertAllowedTrustedHostnameResolvedAddresses(results);
  }
  const addresses = dedupeAndPreferIpv4(results);
  if (!addresses.length) throw new Error(`Unable to resolve hostname: ${hostname}`);
  return {
    hostname: normalized,
    addresses,
    lookup: createPinnedLookup({ hostname: normalized, addresses })
  };
}

export function assertHostnameAllowedWithPolicy(hostname: any, policy: any) {
  return resolveHostnamePolicyChecks(hostname, policy).normalized;
}

export function createPinnedDispatcher(pinned: any, policy: any, timeoutMs: any) {
  const connect = { lookup: pinned.lookup, ...(policy?.connect || {}) };
  const ms = Math.max(1000, timeoutMs ?? 30_000);
  if (!policy || policy.mode === 'direct' || !policy.mode) {
    return new Agent({ connect, bodyTimeout: ms, headersTimeout: ms } as any);
  }
  if (policy.mode === 'env-proxy') {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxy) {
      return new ProxyAgent({ uri: proxy, requestTls: { connect }, connectTimeout: ms } as any);
    }
    return new Agent({ connect, bodyTimeout: ms, headersTimeout: ms } as any);
  }
  if (policy.mode === 'explicit-proxy' && policy.proxyUrl) {
    return new ProxyAgent({
      uri: policy.proxyUrl,
      requestTls: { connect },
      connectTimeout: ms
    } as any);
  }
  return new Agent({ connect, bodyTimeout: ms, headersTimeout: ms } as any);
}

export async function closeDispatcher(dispatcher: any) {
  if (!dispatcher) return;
  const candidate = dispatcher;
  const close = candidate.close?.bind(candidate);
  if (typeof close !== 'function') {
    candidate.destroy?.();
    return;
  }
  let timeout;
  try {
    await Promise.race([
      Promise.resolve(close()),
      new Promise((resolve: any) => {
        timeout = setTimeout(() => {
          candidate.destroy?.();
          resolve();
        }, DISPATCHER_CLOSE_TIMEOUT_MS);
        timeout.unref?.();
      })
    ]);
  } catch {
    candidate.destroy?.();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** 对 URL 做完整 SSRF 校验（含 DNS） */
export async function assertUrlSafeForFetch(urlString: any, policy: any = {}, lookupFn?: any) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    throw new SsrFBlockedError('Invalid URL: must be http or https');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new SsrFBlockedError('Invalid URL: must be http or https');
  }
  const effectivePolicy = resolveSsrFPolicyForUrl(u, policy);
  await resolvePinnedHostnameWithPolicy(u.hostname, { policy: effectivePolicy, lookupFn });
}
