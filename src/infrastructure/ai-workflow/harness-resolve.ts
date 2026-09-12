/**
 * Resolve @xrkseek/harness SDK from the package dependency, or an entry override.
 * Override: XRK_HARNESS_SDK = absolute path to SDK entry (e.g. dist/index.js).
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { normalizeError } from '#utils/normalize-error.js';

/** Minimum published SDK line AGT embeds against (docs + package.json pin). */
export const HARNESS_SDK_PIN = '0.3.3';

/** Public SDK namespace (package default export surface). */
export type HarnessSdkModule = typeof import('@xrkseek/harness');

let cached: HarnessSdkModule | null = null;
let cachedError: Error | null = null;

function resolveOverrideEntry(): string | null {
  const override = process.env.XRK_HARNESS_SDK;
  if (!override || !String(override).trim()) return null;
  return path.resolve(String(override).trim());
}

/**
 * When loading a built SDK entry outside node_modules, prepend nearby
 * node_modules that contain @xrkseek so leaf packages resolve.
 */
function preferNearbyXrkseekNodeModules(entryFile: string): void {
  let dir = path.dirname(entryFile);
  for (let i = 0; i < 8; i += 1) {
    const nm = path.join(dir, 'node_modules');
    const marker = path.join(nm, '@xrkseek');
    if (fs.existsSync(marker)) {
      const prev = process.env.NODE_PATH || '';
      if (!prev.split(path.delimiter).includes(nm)) {
        process.env.NODE_PATH = prev ? `${nm}${path.delimiter}${prev}` : nm;
      }
      try {
        createRequire(path.join(dir, 'package.json'));
      } catch {
        /* ignore */
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/**
 * Read installed package version when resolvable (override builds may omit).
 * Note: `@xrkseek/harness/package.json` is not in package exports — walk up from entry.
 */
export function readInstalledHarnessVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    let start: string;
    try {
      start = require.resolve('@xrkseek/harness/package.json');
      const pkg = JSON.parse(fs.readFileSync(start, 'utf8')) as { version?: string };
      return pkg.version ? String(pkg.version) : null;
    } catch {
      start = require.resolve('@xrkseek/harness');
    }

    let dir = path.dirname(start);
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === '@xrkseek/harness' && pkg.version) {
          return String(pkg.version);
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @returns harness SDK namespace
 */
export async function importHarnessSdk(): Promise<HarnessSdkModule> {
  if (cached) return cached;
  if (cachedError) throw cachedError;

  const override = resolveOverrideEntry();
  try {
    if (override) {
      preferNearbyXrkseekNodeModules(override);
      cached = (await import(pathToFileURL(override).href)) as HarnessSdkModule;
      return cached;
    }
    cached = await import('@xrkseek/harness');
    return cached;
  } catch (err: unknown) {
    const msg = normalizeError(err).message;
    const hint = override
      ? `XRK_HARNESS_SDK=${override}`
      : `pnpm add @xrkseek/harness@${HARNESS_SDK_PIN}（或 Release tarball；开发未发布构建可设 XRK_HARNESS_SDK=绝对路径/入口）`;
    const wrapped = new Error(`@xrkseek/harness 不可用（${hint}）。${msg}`);
    (wrapped as Error & { cause?: unknown }).cause = err;
    cachedError = wrapped;
    throw wrapped;
  }
}

export function resetHarnessSdkCache(): void {
  cached = null;
  cachedError = null;
}
