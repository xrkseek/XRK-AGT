import { pathToFileURL } from 'node:url';
import paths from './paths.js';
import { scanFiles } from './core-fs.js';
import { LOADER_BATCH_SIZE } from './loader-constants.js';
import { MODULE_EXTS, preferSourceModules } from './module-ext.ts';

export class FileLoader {
  /** @param {string} absPath @returns {Promise<Record<string, unknown>>} */
  static importFresh(absPath) {
    return import(`${pathToFileURL(absPath).href}?t=${Date.now()}`);
  }

  static async readFiles(dir, options = {}) {
    const ext = options.ext == null ? [...MODULE_EXTS] : options.ext;
    return preferSourceModules(await scanFiles(dir, { ...options, ext }));
  }

  /**
   * @param {string} subDir
   * @param {{ ext?: string|string[], recursive?: boolean }} [options]
   *   默认扫描 {@link MODULE_EXTS}；同名 .js/.ts 优先 .ts
   */
  static async getCoreSubDirFiles(subDir, options = {}) {
    const subDirs = await paths.getCoreSubDirs(subDir);
    if (subDirs.length === 0) return [];
    const ext = options.ext == null ? [...MODULE_EXTS] : options.ext;
    const batches = await Promise.all(
      subDirs.map((dir) => scanFiles(dir, { ...options, ext })),
    );
    return preferSourceModules(batches.flat());
  }

  static async mapInBatches(items, size, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += size) {
      results.push(...await Promise.allSettled(items.slice(i, i + size).map(fn)));
    }
    return results;
  }

  static async forEachBatch(items, size, fn) {
    await FileLoader.mapInBatches(items, size ?? LOADER_BATCH_SIZE, fn);
  }
}

export { MODULE_EXTS, preferSourceModules };
