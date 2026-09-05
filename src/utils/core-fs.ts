import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { SCAN_IGNORE_PREFIXES } from './loader-constants.js';
import { moduleFileKey, resolveModuleInDir, stripModuleExt } from './module-ext.js';

export type ScanOptions = {
  ext?: string | string[] | null;
  recursive?: boolean;
  ignore?: readonly string[];
  exclude?: string[];
};

export type NormalizedScanOptions = {
  ext: string | string[] | '';
  recursive: boolean;
  ignore: readonly string[];
  exclude: string[];
};

export type CoreSubDirMap = Record<string, string[]>;

export function normalizeScanOptions({
  ext = '',
  recursive = true,
  ignore = SCAN_IGNORE_PREFIXES,
  exclude = [],
}: ScanOptions = {}): NormalizedScanOptions {
  return { ext: ext ?? '', recursive, ignore, exclude };
}

async function walkDir(dir: string, opts: NormalizedScanOptions, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const exts = opts.ext
    ? (Array.isArray(opts.ext) ? opts.ext : [opts.ext])
    : null;

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (opts.ignore.some((prefix) => entry.name.startsWith(prefix))) continue;
    if (opts.exclude.includes(entry.name)) continue;

    if (entry.isDirectory()) {
      if (opts.recursive) await walkDir(fullPath, opts, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (exts && !exts.some((e) => entry.name.endsWith(e))) continue;
    out.push(fullPath);
  }
}

export async function scanFiles(dir: string, options?: ScanOptions): Promise<string[]> {
  const files: string[] = [];
  await walkDir(dir, normalizeScanOptions(options), files);
  return files;
}

function statKindSync(pathsList: string[], kind: 'isDirectory' | 'isFile'): boolean[] {
  return pathsList.map((p) => {
    try {
      return fs.statSync(p)[kind]();
    } catch {
      return false;
    }
  });
}

export const statDirs = (pathsList: string[]) => statKindSync(pathsList, 'isDirectory');
export const statFiles = (pathsList: string[]) => statKindSync(pathsList, 'isFile');

export async function discoverCoreSubDirs(
  coreRoot: string,
  subDirNames: string[],
): Promise<CoreSubDirMap> {
  const result: CoreSubDirMap = Object.fromEntries(subDirNames.map((name) => [name, []]));
  const entries = await fsPromises.readdir(coreRoot, { withFileTypes: true });
  const coreDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(coreRoot, e.name));

  const candidates: { subName: string; fullPath: string }[] = [];
  for (const coreDir of coreDirs) {
    for (const subName of subDirNames) {
      candidates.push({ subName, fullPath: path.join(coreDir, subName) });
    }
  }
  if (candidates.length === 0) return result;

  const exists = statDirs(candidates.map((c) => c.fullPath));
  candidates.forEach((c, i) => {
    if (exists[i]) result[c.subName].push(c.fullPath);
  });
  return result;
}

function mergeCoreSubDirMaps(
  repoMap: CoreSubDirMap,
  extraMap: CoreSubDirMap,
  subDirNames: string[],
): CoreSubDirMap {
  const merged: CoreSubDirMap = Object.fromEntries(subDirNames.map((name) => [name, []]));
  for (const name of subDirNames) {
    const seen = new Set<string>();
    for (const list of [repoMap[name], extraMap[name]]) {
      for (const dirPath of list ?? []) {
        const key = path.resolve(dirPath).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged[name].push(path.resolve(dirPath));
      }
    }
    merged[name].sort();
  }
  return merged;
}

/** 合并 repo core、子服 apis core、办事工作区 core 的 Loader 扫描结果 */
export async function discoverAllCoreSubDirs(
  repoRoot: string,
  coreRoot: string,
  subDirNames: string[],
  subserverSubDirNames: string[] = subDirNames,
): Promise<CoreSubDirMap> {
  const repo = await discoverCoreSubDirs(coreRoot, subDirNames);
  const subserver = await discoverSubserverPluginCoreSubDirs(repoRoot, subserverSubDirNames);
  const workspace = await discoverWorkspaceAgentCoreSubDirs(repoRoot, subDirNames);
  return mergeCoreSubDirMaps(
    mergeCoreSubDirMaps(repo, subserver, subDirNames),
    workspace,
    subDirNames,
  );
}

const SUBSERVER_PLUGIN_CORE_SKIP = new Set(['system']);

/**
 * 办事工作区业务 Core：`data/ai-workspace/{id}/core/<Core名>/{plugin,http,…}`
 */
export async function discoverWorkspaceAgentCoreSubDirs(
  repoRoot: string,
  subDirNames: string[],
): Promise<CoreSubDirMap> {
  const result: CoreSubDirMap = Object.fromEntries(subDirNames.map((name) => [name, []]));
  const wsRoot = path.join(repoRoot, 'data', 'ai-workspace');

  let wsEntries;
  try {
    wsEntries = await fsPromises.readdir(wsRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  const candidates: { subName: string; fullPath: string }[] = [];
  for (const wsEntry of wsEntries) {
    if (!wsEntry.isDirectory() || wsEntry.name.startsWith('.')) continue;
    const coreRoot = path.join(wsRoot, wsEntry.name, 'core');
    let coreEntries;
    try {
      coreEntries = await fsPromises.readdir(coreRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const coreEntry of coreEntries) {
      if (!coreEntry.isDirectory() || coreEntry.name.startsWith('.')) continue;
      for (const subName of subDirNames) {
        candidates.push({
          subName,
          fullPath: path.join(coreRoot, coreEntry.name, subName),
        });
      }
    }
  }

  if (candidates.length === 0) return result;

  const exists = statDirs(candidates.map((c) => c.fullPath));
  candidates.forEach((c, i) => {
    if (exists[i]) result[c.subName].push(path.resolve(c.fullPath));
  });

  for (const subName of subDirNames) {
    result[subName].sort();
  }
  return result;
}

export async function discoverSubserverPluginCoreSubDirs(
  repoRoot: string,
  subDirNames: string[],
): Promise<CoreSubDirMap> {
  const result: CoreSubDirMap = Object.fromEntries(subDirNames.map((name) => [name, []]));
  const subserverRoot = path.join(repoRoot, 'subserver');

  let runtimeEntries;
  try {
    runtimeEntries = await fsPromises.readdir(subserverRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  const candidates: { subName: string; fullPath: string }[] = [];
  for (const runtimeEntry of runtimeEntries) {
    if (!runtimeEntry.isDirectory() || runtimeEntry.name.startsWith('.')) continue;

    const apisRoots = new Set<string>();
    for (const apisFolder of ['apis', 'Apis']) {
      const apisRoot = path.join(subserverRoot, runtimeEntry.name, apisFolder);
      try {
        const stat = await fsPromises.stat(apisRoot);
        if (stat.isDirectory()) apisRoots.add(path.resolve(apisRoot));
      } catch {
        /* runtime 无 apis 目录 */
      }
    }

    for (const apisRoot of apisRoots) {
      let groupEntries;
      try {
        groupEntries = await fsPromises.readdir(apisRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const groupEntry of groupEntries) {
        if (!groupEntry.isDirectory()) continue;
        if (groupEntry.name.startsWith('_') || SUBSERVER_PLUGIN_CORE_SKIP.has(groupEntry.name)) {
          continue;
        }

        for (const subName of subDirNames) {
          candidates.push({
            subName,
            fullPath: path.join(apisRoot, groupEntry.name, 'core', subName),
          });
        }
      }
    }
  }

  if (candidates.length === 0) return result;

  const exists = statDirs(candidates.map((c) => c.fullPath));
  candidates.forEach((c, i) => {
    if (exists[i]) result[c.subName].push(path.resolve(c.fullPath));
  });

  for (const subName of subDirNames) {
    result[subName].sort();
  }
  return result;
}

/** 从 core 扩展目录内绝对路径解析模块归属（repo Core 名或子服插件组名） */
export function resolveCoreExtensionLabel(filePath: string, subDir = 'plugin'): string {
  const normalized = path.resolve(filePath);
  const parts = normalized.split(path.sep);
  const apisIdx = parts.findIndex((part) => part.toLowerCase() === 'apis');
  if (
    apisIdx >= 0
    && parts[apisIdx + 2]?.toLowerCase() === 'core'
    && parts[apisIdx + 3] === subDir
    && parts[apisIdx + 1]
  ) {
    return parts[apisIdx + 1];
  }
  return path.basename(path.dirname(path.dirname(normalized)));
}

export function resolvePluginCoreLabel(filePath: string): string {
  return resolveCoreExtensionLabel(filePath, 'plugin');
}

export function readTextFilesSync(pathsList: string[]): (string | null)[] {
  return pathsList.map((p) => {
    try {
      if (!fs.statSync(p).isFile()) return null;
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });
}

export function pickFirstExistingSync(pathsList: string[]): number {
  return pathsList.findIndex((p) => fs.existsSync(p));
}

export function findInCoreSubDirs(subDirs: string[], fileBaseName: string): string | null {
  for (const dir of subDirs) {
    const hit = resolveModuleInDir(dir, fileBaseName, (p) => fs.existsSync(p));
    if (hit) return hit;
  }
  return null;
}

export type ResolveCoreModuleKeyOptions = {
  qualifyCore?: boolean;
  subDir?: string;
};

/**
 * 从 core 子目录内绝对路径解析模块 key（相对该子目录，不含扩展名）
 * qualifyCore=true 时前缀 Core/插件组名，避免多 Core 同名覆盖（如 `system-Core/admin`）
 */
export function resolveCoreModuleKey(
  filePath: string,
  coreDirs: string[] = [],
  options: ResolveCoreModuleKeyOptions = {},
): string {
  const qualifyCore = options.qualifyCore === true;
  const subDir = options.subDir || path.basename(coreDirs[0] || 'http');
  const normalizedPath = path.resolve(filePath);
  for (const coreDir of coreDirs) {
    const normalizedCoreDir = path.resolve(coreDir);
    const rel = path.relative(normalizedCoreDir, normalizedPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const relKey = stripModuleExt(rel.replace(/\\/g, '/'));
      if (!qualifyCore) return relKey;
      const label = resolveCoreExtensionLabel(normalizedPath, path.basename(normalizedCoreDir) || subDir);
      return `${label}/${relKey}`;
    }
  }
  const base = moduleFileKey(filePath);
  if (!qualifyCore) return base;
  return `${resolveCoreExtensionLabel(normalizedPath, subDir)}/${base}`;
}

/** 多 Core 友好的模块 key（始终带 Core/组名前缀） */
export function resolveQualifiedCoreModuleKey(
  filePath: string,
  coreDirs: string[] = [],
  subDir = 'http',
): string {
  return resolveCoreModuleKey(filePath, coreDirs, { qualifyCore: true, subDir });
}

export function matchEventPattern(pattern: string, event: string): boolean {
  if (pattern === event) return true;
  if (!pattern.includes('*')) return false;

  const patternParts = pattern.split('.');
  const eventParts = event.split('.');
  if (patternParts.length !== eventParts.length) return false;

  return patternParts.every((part, i) => part === '*' || part === eventParts[i]);
}
