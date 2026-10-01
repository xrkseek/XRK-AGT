import { existsSync } from 'node:fs';

/**
 * 休眠函数
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type ForwardMsgCapable = {
  group?: { makeForwardMsg?: (msgs: Array<{ message: unknown }>) => unknown };
  friend?: { makeForwardMsg?: (msgs: Array<{ message: unknown }>) => unknown };
};

/**
 * 制作转发消息
 */
export const makeForwardMsg = (
  e: ForwardMsgCapable | null | undefined,
  msg: unknown[] | string = [],
  dec = '',
): unknown => {
  const messages = Array.isArray(msg) ? msg : [msg];
  const forwardMsg = dec
    ? [{ message: dec }, ...messages.map((message) => ({ message }))]
    : messages.map((message) => ({ message }));

  return (
    e?.group?.makeForwardMsg?.(forwardMsg) ??
    e?.friend?.makeForwardMsg?.(forwardMsg) ??
    (globalThis as { AgentRuntime?: { makeForwardMsg?: (msgs: Array<{ message: unknown }>) => unknown } })
      .AgentRuntime?.makeForwardMsg?.(forwardMsg)
  );
};

/**
 * 检测是否为 Docker 环境
 */
export const isDockerEnvironment = (): boolean => {
  return process.env.DOCKER_CONTAINER === '1' || existsSync('/.dockerenv');
};

/**
 * 规范化主机地址（移除引号，处理 Docker 服务名）
 */
export const normalizeHost = (host: unknown, serviceName: string): string => {
  const hostStr = String(host).replace(/^["']|["']$/g, '');
  if (!isDockerEnvironment() && hostStr === serviceName) {
    return '127.0.0.1';
  }
  return hostStr;
};

export default {
  sleep,
  makeForwardMsg,
  isDockerEnvironment,
  normalizeHost,
};
