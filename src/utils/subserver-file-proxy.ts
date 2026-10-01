/**
 * data/ 相对路径 → 子服务端文件 API 代理（供 /subserver-file 与业务插件共用）
 */
import { parseDataSubserverPath } from '#utils/subserver-runtimes.js';

export type SubserverFileRoute = {
  prefix: string;
  upstream: string;
  runtime: string;
};

/**
 * @param relPath data/ 下相对路径（posix）
 */
export function resolveSubserverFileUpstream(relPath: string): SubserverFileRoute | null {
  const parsed = parseDataSubserverPath(relPath);
  if (!parsed) return null;
  const { dir, runtime } = parsed;
  return {
    prefix: `data/${dir}/`,
    upstream: `/api/${dir}/file`,
    runtime,
  };
}

/**
 * @param baseUrl 主服务公网根地址
 * @param relPath data/ 相对路径
 */
export function buildSubserverFileLink(baseUrl: string, relPath: string): string {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base || !relPath) return '';
  const params = new URLSearchParams({ path: relPath });
  return `${base}/subserver-file?${params}`;
}
