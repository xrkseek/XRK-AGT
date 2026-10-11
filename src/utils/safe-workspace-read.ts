/**
 * 工作区内安全读文本：根与文件均经 realpath，校验包含关系并限制字节数。
 */
import fs from 'node:fs';
import { isPathInside, realpathSyncOrResolve } from '#utils/path-guards.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export type WorkspaceReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/**
 * @param rootResolved 工作区根
 * @param absolutePath 待读文件绝对路径
 */
export function readTextFileUnderWorkspaceRoot(
  rootResolved: string,
  absolutePath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): WorkspaceReadResult {
  const rootReal = realpathSyncOrResolve(rootResolved);
  const fileReal = realpathSyncOrResolve(absolutePath);

  if (!isPathInside(rootReal, fileReal)) {
    return { ok: false, reason: 'outside_root' };
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(fileReal);
  } catch {
    return { ok: false, reason: 'io' };
  }

  if (!st.isFile()) {
    return { ok: false, reason: 'not_file' };
  }

  if (st.size > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }

  try {
    const content = fs.readFileSync(fileReal, 'utf8');
    return { ok: true, content };
  } catch {
    return { ok: false, reason: 'io' };
  }
}
