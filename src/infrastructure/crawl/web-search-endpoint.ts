/**
 */
import { assertUrlSafeForFetch } from './ssrf-policy.js';
import { isPrivateIpAddress } from './ssrf-ip-policy.js';
import { resolvePinnedHostnameWithPolicy } from './ssrf-policy.js';

type EndpointParams = {
  url: string;
  timeoutSeconds?: number;
  init?: RequestInit;
  ssrfPolicy?: Record<string, unknown>;
  signal?: AbortSignal;
};

export async function withTrustedWebSearchEndpoint<T>(
  params: EndpointParams,
  handler: (response: Response) => Promise<T>,
): Promise<T> {
  const { url, timeoutSeconds = 20, init = {}, ssrfPolicy = {} } = params;
  await assertUrlSafeForFetch(url, ssrfPolicy);
  const signal = params.signal ?? init.signal ?? AbortSignal.timeout(timeoutSeconds * 1000);
  const response = await fetch(url, { ...init, signal });
  return handler(response);
}

/**
 * 自托管实例（SearXNG / 私有 Firecrawl）允许内网解析
 */
export async function withSelfHostedWebSearchEndpoint<T>(
  params: EndpointParams,
  handler: (response: Response) => Promise<T>,
): Promise<T> {
  return withTrustedWebSearchEndpoint(
    {
      ...params,
      ssrfPolicy: {
        allowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
        ...(params.ssrfPolicy ?? {}),
      },
    },
    handler,
  );
}

export async function throwWebSearchApiError(response: Response, label: string): Promise<never> {
  const detail = await response.text().catch(() => '');
  throw new Error(`${label} API error (${response.status}): ${detail || response.statusText}`);
}

/**
 * @returns 'selfHosted' | 'strict'
 */
export async function validateSelfHostedBaseUrl(
  baseUrl: string,
  lookupFn?: unknown,
): Promise<'selfHosted' | 'strict'> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('Base URL must be a valid http:// or https:// URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL must use http:// or https://.');
  }
  if (parsed.protocol === 'http:') {
    return 'selfHosted';
  }
  try {
    const pinned = (await resolvePinnedHostnameWithPolicy(parsed.hostname, {
      lookupFn,
      policy: { allowPrivateNetwork: true, allowRfc2544BenchmarkRange: true },
    })) as { addresses: string[] };
    const allPrivate = pinned.addresses.every((addr) => isPrivateIpAddress(addr));
    return allPrivate ? 'selfHosted' : 'strict';
  } catch {
    return 'strict';
  }
}
