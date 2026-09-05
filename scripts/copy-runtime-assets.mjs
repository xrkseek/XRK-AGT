/**
 * 将运行时非代码资源复制到 dist/：
 * - core/ → dist/core/（跳过 www/site/node_modules；.js/.ts 由 tsc 产出）
 * - src/renderers/ 下 yaml 等 → dist/src/renderers/
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIR = new Set(['node_modules', '.git', 'www', 'site']);
const CODE_EXT = new Set(['.js', '.ts', '.mjs', '.mts', '.cjs', '.cts']);

async function walkCopy(srcRoot, destRoot, { skipWww = false } = {}) {
  async function walk(dir, rel = '') {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (skipWww && SKIP_DIR.has(ent.name)) continue;
      if (!skipWww && (ent.name === 'node_modules' || ent.name === '.git')) continue;
      const from = path.join(dir, ent.name);
      const relPath = path.join(rel, ent.name);
      if (ent.isDirectory()) {
        await walk(from, relPath);
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      if (CODE_EXT.has(ext)) continue;
      const to = path.join(destRoot, relPath);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }
  await fs.mkdir(destRoot, { recursive: true });
  await walk(srcRoot);
}

await walkCopy(path.join(root, 'core'), path.join(root, 'dist', 'core'), { skipWww: true });
await walkCopy(path.join(root, 'src', 'renderers'), path.join(root, 'dist', 'src', 'renderers'));
console.log('copy-runtime-assets: core + renderers assets → dist');
