import { ProxyAgent } from 'undici';
import { normalizeError } from '#utils/normalize-error.js';

/**
 * 为全局 fetch 请求构建带代理能力的配置（Undici dispatcher）
 * @param {Object} config - LLM 配置对象，支持：
 *   - proxy: { enabled: boolean, url: string }  // url 例：http://127.0.0.1:<port>
 *   - 或简写：proxy: "http://127.0.0.1:<port>"
 * @param {Object} baseOptions - 原始 fetch 选项
 * @returns {Object} 合并后的 fetch 选项
 */
export function buildFetchOptionsWithProxy(config = {}, baseOptions = {}) {
  const options = { ...baseOptions };

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
    AgentRuntime?.makeLog?.(
      'warn',
      `[LLM Proxy] 创建代理失败: ${normalizeError(err).message}`
    );
  }

  return options;
}

/**
 * 按 provider.proxy 生成带 ProxyAgent 的 fetch（供 harness 等裸 fetch 入口）
 * @returns {typeof fetch | undefined}
 */
export function createFetchWithProxy(config = {}) {
  const { dispatcher } = buildFetchOptionsWithProxy(config, {});
  if (!dispatcher) return undefined;
  return (url, init = {}) => fetch(url, { ...init, dispatcher });
}
