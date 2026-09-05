/**
 * SSRF 防护入口 — 委托 完整策略（ssrf-policy.js）
 */
export {
  SsrFBlockedError,
  assertUrlSafeForFetch,
  resolvePinnedHostnameWithPolicy,
  createPinnedDispatcher,
  closeDispatcher,
  mergeSsrFPolicies,
  resolveSsrFPolicyForUrl,
  matchesHostnameAllowlist,
  isPrivateNetworkAllowedByPolicy,
  assertHostnameAllowedWithPolicy,
} from './ssrf-policy.js';

import { isPrivateIpAddress, isBlockedSpecialUseIpv6Address } from './ssrf-ip-policy.js';

export function isPrivateOrReservedIpv4(ip: string): boolean {
  return isPrivateIpAddress(ip);
}

export function isBlockedIpv6(ip: string): boolean {
  return isBlockedSpecialUseIpv6Address(ip);
}
