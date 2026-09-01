/**
 * Core / Loader 模块源文件约定（JS + TS）。
 * Node ≥26：进程须带 `--experimental-strip-types` 才能 import `.ts`。
 */
import path from 'node:path';

export const MODULE_EXTS = Object.freeze(['.js', '.ts', '.mjs', '.mts'] as const);

export type ModuleExt = (typeof MODULE_EXTS)[number];

const EXT_RE = /\.(?:[cm]?js|[cm]?ts)$/i;

const MODULE_EXT_SET = new Set<string>(MODULE_EXTS);

export function isModuleSourceFile(fileName: string): boolean {
  const base = path.basename(String(fileName ?? ''));
  if (!base || base.startsWith('.') || base.startsWith('_')) return false;
  return MODULE_EXTS.some((ext) => base.endsWith(ext));
}

export function stripModuleExt(filePath: string): string {
  return String(filePath ?? '').replace(EXT_RE, '');
}

export function moduleFileKey(filePath: string): string {
  return path.basename(stripModuleExt(filePath));
}

function extRank(ext: string): number {
  const e = ext.toLowerCase();
  if (e === '.ts' || e === '.mts') return 2;
  if (e === '.js' || e === '.mjs') return 1;
  return 0;
}

/**
 * 同 stem 并存 .js/.ts 时优先 .ts（迁移期：TS 为源，JS 可暂留对照）。
 */
export function preferSourceModules(files: string[]): string[] {
  const byStem = new Map<string, string>();
  for (const f of files || []) {
    if (!f) continue;
    const ext = path.extname(f);
    if (!MODULE_EXT_SET.has(ext) && !MODULE_EXT_SET.has(ext.toLowerCase())) continue;
    const stem = stripModuleExt(f).toLowerCase();
    const prev = byStem.get(stem);
    if (!prev || extRank(ext) >= extRank(path.extname(prev))) {
      byStem.set(stem, f);
    }
  }
  return [...byStem.values()].sort((a, b) => a.localeCompare(b));
}

/** 在目录下解析 basename（无扩展名）→ 绝对路径；优先 .ts。 */
export function resolveModuleInDir(
  dir: string,
  baseName: string,
  existsSync: (p: string) => boolean,
): string | null {
  const candidates = [
    path.join(dir, `${baseName}.ts`),
    path.join(dir, `${baseName}.mts`),
    path.join(dir, `${baseName}.js`),
    path.join(dir, `${baseName}.mjs`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}
