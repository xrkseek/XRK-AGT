import { pathToFileURL } from 'node:url';
import paths from './paths.js';
import { scanFiles } from './core-fs.js';
import { LOADER_BATCH_SIZE } from './loader-constants.js';
import { MODULE_EXTS, preferSourceModules } from './module-ext.js';

export type ScanFileOptions = {
  ext?: string | string[] | null;
  recursive?: boolean;
  ignore?: readonly string[];
  exclude?: string[];
};

export class FileLoader {
  static importFresh(absPath: string): Promise<Record<string, unknown>> {
    return import(`${pathToFileURL(absPath).href}?t=${Date.now()}`) as Promise<Record<string, unknown>>;
  }

  static async readFiles(dir: string, options: ScanFileOptions = {}): Promise<string[]> {
    const ext = options.ext == null ? [...MODULE_EXTS] : options.ext;
    return preferSourceModules(await scanFiles(dir, { ...options, ext }));
  }

  /**
   * 默认扫描 {@link MODULE_EXTS}；同名 .js/.ts 优先 .ts
   */
  static async getCoreSubDirFiles(subDir: string, options: ScanFileOptions = {}): Promise<string[]> {
    const subDirs = await paths.getCoreSubDirs(subDir);
    if (subDirs.length === 0) return [];
    const ext = options.ext == null ? [...MODULE_EXTS] : options.ext;
    const batches = await Promise.all(
      subDirs.map((dir) => scanFiles(dir, { ...options, ext })),
    );
    return preferSourceModules(batches.flat());
  }

  static async mapInBatches<T, R>(
    items: T[],
    size: number,
    fn: (item: T, index: number) => Promise<R> | R,
  ): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = [];
    for (let i = 0; i < items.length; i += size) {
      results.push(
        ...(await Promise.allSettled(items.slice(i, i + size).map((item, j) => fn(item, i + j)))),
      );
    }
    return results;
  }

  static async forEachBatch<T>(
    items: T[],
    size: number | undefined,
    fn: (item: T, index: number) => Promise<unknown> | unknown,
  ): Promise<void> {
    await FileLoader.mapInBatches(items, size ?? LOADER_BATCH_SIZE, fn);
  }
}

export { MODULE_EXTS, preferSourceModules };
