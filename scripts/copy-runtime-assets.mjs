/**
 * 将 core/ 下非代码资源复制到 dist/core/（yaml/json/html/…）。
 * .js/.ts 等由 tsc 产出；www/site 仍由源码树提供（paths.coreSource）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcCore = path.join(root, 'core');
const destCore = path.join(root, 'dist', 'core');
const SKIP_DIR = new Set(['node_modules', '.git', 'www', 'site']);
const CODE_EXT = new Set(['.js', '.ts', '.mjs', '.mts', '.cjs', '.cts']);

async function walk(dir, rel = '') {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (SKIP_DIR.has(ent.name) || ent.name.startsWith('.')) continue;
    const from = path.join(dir, ent.name);
    const relPath = path.join(rel, ent.name);
    if (ent.isDirectory()) {
      await walk(from, relPath);
      continue;
    }
    const ext = path.extname(ent.name).toLowerCase();
    if (CODE_EXT.has(ext)) continue;
    const to = path.join(destCore, relPath);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
}

await fs.mkdir(destCore, { recursive: true });
await walk(srcCore);
console.log('copy-runtime-assets: core assets → dist/core (skipped www/site)');
