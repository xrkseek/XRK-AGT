/**
 * 安全网卡枚举与 Windows `uv_interface_addresses` 错误识别。
 *
 * Windows 上 `os.networkInterfaces()` / systeminformation 偶发
 * `ERR_SYSTEM_ERROR`（Unknown system error 2），不可未捕获炸穿进程。
 *
 * 消费方：`SystemMonitor`、ProcessManager（`#infrastructure/config/loader.js`）等。
 *
 * @module #utils/safe-os-network
 */
import os from 'node:os';

/**
 * 安全读取网卡列表；失败时返回空对象且不抛。
 */
export function safeOsNetworkInterfaces(): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  try {
    return os.networkInterfaces() || {};
  } catch {
    return {};
  }
}

/**
 * 判断错误是否为网卡枚举类系统错误（可忽略、勿自动重启）。
 *
 * 匹配：`code === 'ERR_SYSTEM_ERROR'`，或 message 含
 * `uv_interface_addresses` / `Unknown system error 2`。
 */
export function isUvInterfaceAddressesError(err: unknown): boolean {
  const o = err && typeof err === 'object' ? (err as { message?: unknown; code?: unknown }) : null;
  const msg = o && typeof o.message === 'string' ? o.message : String(err ?? '');
  const code = o && typeof o.code === 'string' ? o.code : '';
  return (
    code === 'ERR_SYSTEM_ERROR' ||
    msg.includes('uv_interface_addresses') ||
    msg.includes('Unknown system error 2')
  );
}
