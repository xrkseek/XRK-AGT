/**
 * Core / Loader 模块源文件约定（JS + TS）。
 * 主路径：`pnpm build` → 从 `dist/` 加载编译后的 `.js`（ADR-0004）。
 * 源码树 / 工作区未编译目录仍可出现 `.ts`；同 stem 时见 preferSourceModules。
 * 若直接 import 源码 `.ts`，Node ≥26 须带 `--experimental-strip-types`。
 */
import path from 'node:path';

export const MODULE_EXTS = Object.freeze(['.js', '.ts', '.mjs', '.mts'] as const);

export type ModuleExt = (typeof MODULE_EXTS)[number];

const EXT_RE = /\.(?:[cm]?js|[cm]?ts)$/i;
const DECL_EXT_RE = /\.d\.[cm]?ts$/i;

const MODULE_EXT_SET = new Set<string>(MODULE_EXTS);

/** 路径是否落在编译产物树（`.../dist/...`） */
export function isDistPath(filePath: string): boolean {
  const norm = String(filePath ?? '').replace(/\\/g, '/').toLowerCase();
  return /(^|\/)dist\//.test(norm);
}

export function isDeclarationFile(fileName: string): boolean {
  return DECL_EXT_RE.test(path.basename(String(fileName ?? '')));
}

export function isModuleSourceFile(fileName: string): boolean {
  const base = path.basename(String(fileName ?? ''));
  if (!base || base.startsWith('.') || base.startsWith('_')) return false;
  if (isDeclarationFile(base)) return false;
  return MODULE_EXTS.some((ext) => base.endsWith(ext));
}

export function stripModuleExt(filePath: string): string {
  const s = String(filePath ?? '');
  if (DECL_EXT_RE.test(s)) return s.replace(DECL_EXT_RE, '');
  return s.replace(EXT_RE, '');
}

export function moduleFileKey(filePath: string): string {
  return path.basename(stripModuleExt(filePath));
}

/**
 * dist 下优先 .js（运行时只加载编译产物）；源码树优先 .ts。
 */
function extRank(ext: string, underDist: boolean): number {
  const e = ext.toLowerCase();
  if (underDist) {
    if (e === '.js' || e === '.mjs') return 2;
    if (e === '.ts' || e === '.mts') return 1;
    return 0;
  }
  if (e === '.ts' || e === '.mts') return 2;
  if (e === '.js' || e === '.mjs') return 1;
  return 0;
}

/**
 * 同 stem 去重：`dist/` 内优先 .js，其余优先 .ts；跳过 .d.ts。
 */
export function preferSourceModules(files: string[]): string[] {
  const byStem = new Map<string, string>();
  for (const f of files || []) {
    if (!f || isDeclarationFile(f)) continue;
    const ext = path.extname(f);
    if (!MODULE_EXT_SET.has(ext) && !MODULE_EXT_SET.has(ext.toLowerCase())) continue;
    const underDist = isDistPath(f);
    const stem = stripModuleExt(f).toLowerCase();
    const prev = byStem.get(stem);
    if (
      !prev ||
      extRank(ext, underDist) >= extRank(path.extname(prev), isDistPath(prev))
    ) {
      byStem.set(stem, f);
    }
  }
  return [...byStem.values()].sort((a, b) => a.localeCompare(b));
}

/** 在目录下解析 basename（无扩展名）→ 绝对路径；dist 优先 .js，否则优先 .ts。 */
export function resolveModuleInDir(
  dir: string,
  baseName: string,
  existsSync: (p: string) => boolean,
): string | null {
  const underDist = isDistPath(dir);
  const candidates = underDist
    ? [
        path.join(dir, `${baseName}.js`),
        path.join(dir, `${baseName}.mjs`),
        path.join(dir, `${baseName}.ts`),
        path.join(dir, `${baseName}.mts`),
      ]
    : [
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
