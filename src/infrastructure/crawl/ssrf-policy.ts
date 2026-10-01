/**
 * SSRF 策略：hostname allowlist、私网拒绝（默认）、DNS pinning、pinned undici dispatcher
 * @see .cursor/skills/xrk-crawl/SKILL.md — SSRF 分层
 */
import dns from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, ProxyAgent } from 'undici';
import {
  isCloudMetadataIpAddress,
  isLinkLocalIpAddress,
  isPrivateIpAddress,
  normalizeHostname,
} from './ssrf-ip-policy.js';

export class SsrFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrFBlockedError';
  }
}

/** 安全默认：私网仅显式 true 才放行（dangerously* / allowPrivateNetwork） */
export type SsrFPolicy = {
  allowPrivateNetwork?: boolean;
  /** 显式危险开关；与 allowPrivateNetwork 等价，命名强调风险 */
  dangerouslyAllowPrivateNetwork?: boolean;
  allowRfc2544BenchmarkRange?: boolean;
  allowIpv6UniqueLocalRange?: boolean;
  allowedHostnames?: string[];
  allowedOrigins?: string[];
  hostnameAllowlist?: string[];
  mode?: 'direct' | 'env-proxy' | 'explicit-proxy' | string;
  proxyUrl?: string;
  connect?: Record<string, unknown>;
  [key: string]: unknown;
};

type DnsLookupResult = { address: string; family: number };

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | DnsLookupResult[],
  family?: number,
) => void;

type DnsLookupFn = typeof dns.lookup;

type PromiseLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<DnsLookupResult[]>;

type PinnedLookup = {
  hostname: string;
  addresses: string[];
  lookup: DnsLookupFn;
};

type CloseableDispatcher = {
  close?: () => void | Promise<void>;
  destroy?: () => void;
};

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal'];
const DISPATCHER_CLOSE_TIMEOUT_MS = 100;

export function isPrivateNetworkAllowedByPolicy(policy: SsrFPolicy | null | undefined): boolean {
  // 必须显式 === true；缺省/undefined 一律拒绝私网
  return policy?.dangerouslyAllowPrivateNetwork === true || policy?.allowPrivateNetwork === true;
}

export function normalizeHostnameAllowlist(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out = new Set<string>();
  for (const raw of values) {
    const n = normalizeHostname(raw);
    if (n && n !== '*' && n !== '*.') out.add(n);
  }
  return [...out];
}

export function isHostnameAllowedByPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    if (!suffix || hostname === suffix) return false;
    return hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

export function matchesHostnameAllowlist(
  hostname: string,
  allowlist: string[] | null | undefined,
): boolean {
  if (!allowlist?.length) return true;
  return allowlist.some((pattern) => isHostnameAllowedByPattern(hostname, pattern));
}

export function mergeSsrFPolicies(...policies: Array<SsrFPolicy | null | undefined>): SsrFPolicy | undefined {
  const merged: SsrFPolicy = {};
  for (const policy of policies) {
    if (!policy) continue;
    // 仅显式 true 才合并放行标志（避免 truthy 脏值放宽）
    if (policy.allowPrivateNetwork === true) merged.allowPrivateNetwork = true;
    if (policy.dangerouslyAllowPrivateNetwork === true) merged.dangerouslyAllowPrivateNetwork = true;
    if (policy.allowRfc2544BenchmarkRange === true) merged.allowRfc2544BenchmarkRange = true;
    if (policy.allowIpv6UniqueLocalRange === true) merged.allowIpv6UniqueLocalRange = true;
    if (policy.allowedHostnames?.length) {
      merged.allowedHostnames = [
        ...new Set([...(merged.allowedHostnames ?? []), ...policy.allowedHostnames]),
      ];
    }
    if (policy.allowedOrigins?.length) {
      merged.allowedOrigins = [
        ...new Set([...(merged.allowedOrigins ?? []), ...policy.allowedOrigins]),
      ];
    }
    if (policy.hostnameAllowlist?.length) {
      merged.hostnameAllowlist = [
        ...new Set([...(merged.hostnameAllowlist ?? []), ...policy.hostnameAllowlist]),
      ];
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeOrigin(value: unknown): string | undefined {
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

export function resolveSsrFPolicyForUrl(url: URL, policy: SsrFPolicy | null | undefined): SsrFPolicy | undefined {
  if (!policy?.allowedOrigins?.length) return policy ?? undefined;
  const requestOrigin = normalizeOrigin(url.toString());
  const allowed = (policy.allowedOrigins || []).map(normalizeOrigin).filter(Boolean) as string[];
  if (!requestOrigin || !allowed.includes(requestOrigin)) return policy;
  return {
    ...policy,
    allowedHostnames: [
      ...new Set([...(policy.allowedHostnames ?? []), normalizeHostname(url.hostname)]),
    ],
  };
}

function isBlockedHostnameNormalized(normalized: string): boolean {
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  return BLOCKED_SUFFIXES.some((s) => normalized.endsWith(s));
}

export function isBlockedHostnameOrIp(
  hostnameOrIp: unknown,
  policy: SsrFPolicy | null | undefined,
): boolean {
  const normalized = normalizeHostname(hostnameOrIp);
  if (!normalized) return false;
  if (isBlockedHostnameNormalized(normalized)) return true;
  return isPrivateIpAddress(normalized, policy ?? {});
}

function shouldSkipPrivateNetworkChecks(
  hostname: string,
  policy: SsrFPolicy | null | undefined,
): boolean {
  if (isPrivateNetworkAllowedByPolicy(policy)) return true;
  const allowed = new Set((policy?.allowedHostnames ?? []).map(normalizeHostname));
  return allowed.has(hostname);
}

function resolveHostnamePolicyChecks(
  hostname: unknown,
  policy: SsrFPolicy | null | undefined,
): { normalized: string; skipPrivateNetworkChecks: boolean } {
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

function assertAllowedResolvedAddresses(
  results: DnsLookupResult[],
  policy: SsrFPolicy | null | undefined,
): void {
  for (const entry of results) {
    if (isBlockedHostnameOrIp(entry.address, policy)) {
      throw new SsrFBlockedError('Blocked: resolves to private/internal/special-use IP address');
    }
  }
}

function assertAllowedTrustedHostnameResolvedAddresses(results: DnsLookupResult[]): void {
  for (const entry of results) {
    if (isLinkLocalIpAddress(entry.address) || isCloudMetadataIpAddress(entry.address)) {
      throw new SsrFBlockedError('Blocked: resolves to private/internal/special-use IP address');
    }
  }
}

function dedupeAndPreferIpv4(results: DnsLookupResult[]): string[] {
  const seen = new Set<string>();
  const ipv4: string[] = [];
  const other: string[] = [];
  for (const entry of results) {
    if (seen.has(entry.address)) continue;
    seen.add(entry.address);
    if (entry.family === 4) ipv4.push(entry.address);
    else other.push(entry.address);
  }
  return [...ipv4, ...other];
}

export function createPinnedLookup({
  hostname,
  addresses,
  fallback,
}: {
  hostname: string;
  addresses: string[];
  fallback?: DnsLookupFn;
}): DnsLookupFn {
  const normalizedHost = normalizeHostname(hostname);
  const records = addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));
  const ipv4Records = records.filter((e) => e.family === 4);
  const automaticRecords = ipv4Records.length > 0 ? ipv4Records : records;
  let index = 0;
  const fb = fallback ?? dns.lookup;

  return ((host: string, options: unknown, callback?: LookupCallback) => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback | undefined;
    if (!cb) return;
    const normalized = normalizeHostname(host);
    if (!normalized || normalized !== normalizedHost) {
      if (typeof options === 'function' || options === undefined) {
        return (fb as (h: string, c: LookupCallback) => void)(host, cb);
      }
      return (fb as (h: string, o: unknown, c: LookupCallback) => void)(host, options, cb);
    }
    const opts =
      typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {};
    const requestedFamily =
      typeof options === 'number'
        ? options
        : typeof opts.family === 'number'
          ? opts.family
          : 0;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((e) => e.family === requestedFamily)
        : automaticRecords;
    const usable = candidates.length > 0 ? candidates : automaticRecords;
    if (opts.all) {
      cb(null, usable);
      return;
    }
    const chosen = usable[index % usable.length]!;
    index += 1;
    cb(null, chosen.address, chosen.family);
  }) as DnsLookupFn;
}

export async function resolvePinnedHostnameWithPolicy(
  hostname: unknown,
  params: {
    policy?: SsrFPolicy | null;
    lookupFn?: PromiseLookupFn;
  } = {},
): Promise<PinnedLookup> {
  const { normalized, skipPrivateNetworkChecks } = resolveHostnamePolicyChecks(
    hostname,
    params.policy,
  );
  const lookupFn = params.lookupFn ?? (dnsLookup as PromiseLookupFn);
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
    lookup: createPinnedLookup({ hostname: normalized, addresses }),
  };
}

export function assertHostnameAllowedWithPolicy(
  hostname: unknown,
  policy: SsrFPolicy | null | undefined,
): string {
  return resolveHostnamePolicyChecks(hostname, policy).normalized;
}

export function createPinnedDispatcher(
  pinned: { lookup: DnsLookupFn },
  policy: SsrFPolicy | null | undefined,
  timeoutMs?: number,
): Agent | ProxyAgent {
  const connect = { lookup: pinned.lookup, ...(policy?.connect || {}) };
  const ms = Math.max(1000, timeoutMs ?? 30_000);
  if (!policy || policy.mode === 'direct' || !policy.mode) {
    return new Agent({ connect, bodyTimeout: ms, headersTimeout: ms } as ConstructorParameters<
      typeof Agent
    >[0]);
  }
  if (policy.mode === 'env-proxy') {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxy) {
      return new ProxyAgent({
        uri: proxy,
        requestTls: { connect },
        connectTimeout: ms,
      } as ConstructorParameters<typeof ProxyAgent>[0]);
    }
    return new Agent({ connect, bodyTimeout: ms, headersTimeout: ms } as ConstructorParameters<
      typeof Agent
    >[0]);
  }
  if (policy.mode === 'explicit-proxy' && policy.proxyUrl) {
    return new ProxyAgent({
      uri: policy.proxyUrl,
      requestTls: { connect },
      connectTimeout: ms,
    } as ConstructorParameters<typeof ProxyAgent>[0]);
  }
  return new Agent({ connect, bodyTimeout: ms, headersTimeout: ms } as ConstructorParameters<
    typeof Agent
  >[0]);
}

export async function closeDispatcher(dispatcher: CloseableDispatcher | null | undefined): Promise<void> {
  if (!dispatcher) return;
  const candidate = dispatcher;
  const close = candidate.close?.bind(candidate);
  if (typeof close !== 'function') {
    candidate.destroy?.();
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(close()),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          candidate.destroy?.();
          resolve();
        }, DISPATCHER_CLOSE_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } catch {
    candidate.destroy?.();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** 对 URL 做完整 SSRF 校验（含 DNS） */
export async function assertUrlSafeForFetch(
  urlString: unknown,
  policy: SsrFPolicy | null | undefined = {},
  lookupFn?: PromiseLookupFn,
): Promise<void> {
  let u: URL;
  try {
    u = new URL(String(urlString));
  } catch {
    throw new SsrFBlockedError('Invalid URL: must be http or https');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new SsrFBlockedError('Invalid URL: must be http or https');
  }
  const effectivePolicy = resolveSsrFPolicyForUrl(u, policy);
  await resolvePinnedHostnameWithPolicy(u.hostname, { policy: effectivePolicy, lookupFn });
}
