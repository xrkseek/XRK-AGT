/**
 * 路径包含判断 + realpath 回退（与 OpenClaw path-guards 语义对齐，供工作区 / Skills 共用）。
 */
import fs from 'node:fs';
import path from 'node:path';

export function realpathSyncOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function normalizeWindowsPathForComparison(input: string): string {
  let normalized = path.win32.normalize(input);
  if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4);
    if (normalized.toUpperCase().startsWith('UNC\\')) {
      normalized = `\\\\${normalized.slice(4)}`;
    }
  }
  return normalized.replaceAll('/', '\\').toLowerCase();
}

export function isPathInside(root: string, target: string): boolean {
  if (process.platform === 'win32') {
    const rootForCompare = normalizeWindowsPathForComparison(path.win32.resolve(root));
    const targetForCompare = normalizeWindowsPathForComparison(path.win32.resolve(target));
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
  }
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
