import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const SYSTEM_CORE_DIR = path.join(root, 'core', 'system-Core');

/** 框架基准：仅 `git ls-files` 入库文件；本地未跟踪插件不计 */
export const SYSTEM_CORE_BASELINE = Object.freeze({
  http: 11,
  workflow: 7,
  plugin: 18,
  tasker: 4,
  events: 4,
});

/** @param {string} subdir http | workflow | plugin | tasker | events */
export function listSystemCoreJs(subdir) {
  const globTs = `core/system-Core/${subdir}/*.ts`;
  const globJs = `core/system-Core/${subdir}/*.js`;
  const out = execFileSync('git', ['ls-files', '-z', '--', globTs, globJs], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out
    .split('\0')
    .filter(Boolean)
    .map((p) => path.basename(p));
}

/**
 * 与 HttpApiLoader.getApiKey（resolveQualifiedCoreModuleKey）一致：
 * `system-Core/<相对 http/ 路径无扩展名>`
 */
export function systemCoreHttpApiKeys() {
  return listSystemCoreJs('http').map((f) => `system-Core/${f.replace(/\.(js|ts)$/, '')}`);
}

/** 与 PluginLoader.getPlugins().name（_pluginQualifiedKey）一致 */
export function systemCorePluginKeys() {
  return listSystemCoreJs('plugin').map((f) => `system-Core/${f.replace(/\.(js|ts)$/, '')}`);
}

export function systemCoreStreamBasenames() {
  return listSystemCoreJs('workflow').map((f) => f.replace(/\.(js|ts)$/, ''));
}
