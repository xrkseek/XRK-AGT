/**
 * Resolve @xrkseek/harness SDK from the package dependency, or an entry override.
 * Override: XRK_HARNESS_SDK = absolute path to SDK entry (e.g. dist/index.js).
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

let cached: Record<string, unknown> | null = null;
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
 * @returns harness SDK namespace
 */
export async function importHarnessSdk(): Promise<Record<string, unknown>> {
  if (cached) return cached;
  if (cachedError) throw cachedError;

  const override = resolveOverrideEntry();
  try {
    if (override) {
      preferNearbyXrkseekNodeModules(override);
      cached = (await import(pathToFileURL(override).href)) as Record<string, unknown>;
      return cached;
    }
    cached = (await import('@xrkseek/harness')) as Record<string, unknown>;
    return cached;
  } catch (err) {
    const hint = override
      ? `XRK_HARNESS_SDK=${override}`
      : 'pnpm add @xrkseek/harness（或 Release tarball；开发未发布构建可设 XRK_HARNESS_SDK=绝对路径/入口）';
    const wrapped = new Error(
      `@xrkseek/harness 不可用（${hint}）。${(err as Error)?.message || err}`,
    );
    (wrapped as Error & { cause?: unknown }).cause = err;
    cachedError = wrapped;
    throw wrapped;
  }
}

export function resetHarnessSdkCache(): void {
  cached = null;
  cachedError = null;
}
