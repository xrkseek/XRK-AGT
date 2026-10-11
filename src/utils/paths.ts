import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { discoverAllCoreSubDirs } from './core-fs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 源码在 `src/utils`，编译后在 `dist/src/utils`；后者需再上溯一级到仓库根 */
const _rootCandidate = path.resolve(__dirname, '../..');
const _root =
  path.basename(_rootCandidate) === 'dist'
    ? path.resolve(__dirname, '../../..')
    : _rootCandidate;
const _dist = path.join(_root, 'dist');
const _src = path.join(_root, 'src');
/** Loader 扫描与动态 import 的 Core 根（编译产物） */
const _core = path.join(_dist, 'core');
/** 源码树 Core（www / site 等未拷入 dist 的资源） */
const _coreSource = path.join(_root, 'core');
const _config = path.join(_root, 'config');
const _data = path.join(_root, 'data');
const _trash = path.join(_root, 'trash');
const _resources = path.join(_root, 'resources');
const _www = path.join(_coreSource, 'system-Core', 'site');
const _logs = path.join(_root, 'logs');
const _renderers = path.join(_dist, 'src', 'renderers');

const _baseDirs = [
  _logs,
  _config,
  _data,
  path.join(_data, 'server_bots'),
  path.join(_data, 'uploads'),
  path.join(_data, 'media'),
  path.join(_data, 'ai-workspace'),
  path.join(_data, 'ai-workspace', 'default'),
  path.join(_data, 'stdin'),
  _resources,
  _trash,
  path.join(_trash, 'screenshot'),
  path.join(_trash, 'html'),
];

let _coreDirsCache: string[] | null = null;
const _coreSubDirsCache = new Map<string, string[]>();
let _warmupPromise: Promise<void> | null = null;

const DEFAULT_LOADER_SUBDIRS = [
  'plugin',
  'http',
  'commonconfig',
  'workflow',
  'tasker',
  'events',
] as const;

/** 子服 apis/<group>/core/ 与主仓 core 同结构，主服 Loader 一并扫描 */
const SUBSERVER_PLUGIN_CORE_SUBDIRS = [
  'plugin',
  'http',
  'commonconfig',
  'workflow',
  'tasker',
  'events',
] as const;

function assertDistCoreReady(): Promise<void> {
  return fs.access(_core).then(
    () => undefined,
    () => {
      throw new Error(`未找到编译后的 Core 目录: ${_core}\n请先运行: pnpm build`);
    },
  );
}

function invalidateCoreCache(): void {
  _coreDirsCache = null;
  _coreSubDirsCache.clear();
  _warmupPromise = null;
}

/**
 * 列举 Core 名（以源码 `core/` 为准，含仅有 www 的产品），返回 `dist/core/<名>` 路径供 Loader 使用。
 */
async function listAllCoreDirs(): Promise<string[]> {
  await assertDistCoreReady();
  const entries = await fs.readdir(_coreSource, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(_core, entry.name))
    .sort();
}

async function getCoreDirs(): Promise<string[]> {
  if (_coreDirsCache) return _coreDirsCache;
  _coreDirsCache = await listAllCoreDirs();
  return _coreDirsCache;
}

async function getCoreSubDirs(subDir: string): Promise<string[]> {
  if (!_coreSubDirsCache.has(subDir)) {
    await warmupCoreLayout([subDir]);
  }
  return _coreSubDirsCache.get(subDir) ?? [];
}

async function warmupCoreLayout(
  subDirNames: readonly string[] = DEFAULT_LOADER_SUBDIRS,
): Promise<void> {
  const pending = subDirNames.filter((name) => !_coreSubDirsCache.has(name));
  if (pending.length === 0) return;

  if (!_warmupPromise) {
    _warmupPromise = (async () => {
      await assertDistCoreReady();
      if (!_coreDirsCache) {
        _coreDirsCache = await listAllCoreDirs();
      }

      const discovered = await discoverAllCoreSubDirs(
        _root,
        _core,
        [...DEFAULT_LOADER_SUBDIRS],
        [...SUBSERVER_PLUGIN_CORE_SUBDIRS],
      );

      for (const name of DEFAULT_LOADER_SUBDIRS) {
        _coreSubDirsCache.set(name, discovered[name] ?? []);
      }
    })();
  }

  await _warmupPromise;

  for (const name of pending) {
    if (!_coreSubDirsCache.has(name)) {
      _coreSubDirsCache.set(name, []);
    }
  }
}

const paths = {
  root: _root,
  dist: _dist,
  src: _src,
  core: _core,
  coreSource: _coreSource,
  config: _config,
  data: _data,
  trash: _trash,
  www: _www,
  logs: _logs,
  renderers: _renderers,
  resources: _resources,

  configDefault: path.join(_config, 'default_config'),
  dataServerBots: path.join(_data, 'server_bots'),
  dataModels: path.join(_data, 'models'),
  dataAiWorkspace: path.join(_data, 'ai-workspace'),

  getCoreDirs,
  getCoreSubDirs,
  warmupCoreLayout,
  invalidateCoreCache,

  async ensureBaseDirs() {
    await Promise.all(_baseDirs.map((dir) => fs.mkdir(dir, { recursive: true })));
  },
};

export type Paths = typeof paths;
export default paths;
