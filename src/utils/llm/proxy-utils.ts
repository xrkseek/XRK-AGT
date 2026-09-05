import { ProxyAgent } from 'undici';
import { normalizeError } from '#utils/normalize-error.js';

type ProxyObjectConfig = {
  enabled?: boolean;
  url?: string;
};

type ProxyConfig = ProxyObjectConfig | string;

type FetchConfigWithProxy = {
  proxy?: ProxyConfig;
};

type FetchOptions = Record<string, unknown> & {
  dispatcher?: ProxyAgent;
};

/**
 * 为全局 fetch 请求构建带代理能力的配置（Undici dispatcher）
 */
export function buildFetchOptionsWithProxy(
  config: FetchConfigWithProxy = {},
  baseOptions: FetchOptions = {},
): FetchOptions {
  const options: FetchOptions = { ...baseOptions };

  const proxyConfig = config.proxy;
  if (!proxyConfig) {
    return options;
  }

  const isObjectConfig = typeof proxyConfig === 'object' && proxyConfig !== null;
  const enabled = isObjectConfig ? proxyConfig.enabled === true : true;
  if (!enabled) {
    return options;
  }

  const url = isObjectConfig ? proxyConfig.url : proxyConfig;
  if (!url || typeof url !== 'string') {
    return options;
  }

  try {
    options.dispatcher = new ProxyAgent(url);
  } catch (err) {
    (globalThis as any).AgentRuntime?.makeLog?.(
      'warn',
      `[LLM Proxy] 创建代理失败: ${normalizeError(err).message}`,
    );
  }

  return options;
}

/**
 * 按 provider.proxy 生成带 ProxyAgent 的 fetch（供 harness 等裸 fetch 入口）
 */
export function createFetchWithProxy(
  config: FetchConfigWithProxy = {},
): ((url: any, init?: any) => Promise<Response>) | undefined {
  const { dispatcher } = buildFetchOptionsWithProxy(config, {});
  if (!dispatcher) return undefined;
  return (url, init = {}) => fetch(url, { ...init, dispatcher } as any);
}
