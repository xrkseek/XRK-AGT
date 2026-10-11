/**
 * 将运行时资源复制到 dist/：
 * - core/ → dist/core/（跳过 www/site/node_modules）
 * - 纯 JS Core（无同名 .ts/.mts）：拷贝 .js/.mjs/.cjs（tsc allowJs 关闭后产品 Core 仍靠此进 dist）
 * - src/ 下 .cjs（tsc 不产出，如 system-browser.cjs）→ dist/src/
 * - .ts/.mts/.cts 由 tsc 产出，此处跳过
 * - 非代码资源（yaml/html/图片等）照常拷贝
 * - src/renderers/ 下非代码资源 → dist/src/renderers/
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIR = new Set(['node_modules', '.git', 'www', 'site']);
/** 由 tsc 编译，勿拷 */
const TSC_EXT = new Set(['.ts', '.mts', '.cts']);
/** 无同名 TS 源时拷贝进 dist（纯 JS 产品 Core） */
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
/** tsc 永不产出；无论 copyJsModules 都要拷（require 侧车，如 system-browser.cjs） */
const CJS_SIDECAR_EXT = new Set(['.cjs']);

async function hasTsSibling(dir, baseName) {
  for (const ext of ['.ts', '.mts', '.cts']) {
    try {
      await fs.access(path.join(dir, `${baseName}${ext}`));
      return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

async function walkCopy(srcRoot, destRoot, { skipWww = false, copyJsModules = false } = {}) {
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
      if (TSC_EXT.has(ext)) continue;
      if (JS_EXT.has(ext)) {
        // .cjs 侧车：tsc 不产出，始终拷贝
        if (!CJS_SIDECAR_EXT.has(ext)) {
          if (!copyJsModules) continue;
          const baseName = path.basename(ent.name, ext);
          if (await hasTsSibling(dir, baseName)) continue;
        }
      }
      const to = path.join(destRoot, relPath);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }
  await fs.mkdir(destRoot, { recursive: true });
  await walk(srcRoot);
}

await walkCopy(path.join(root, 'core'), path.join(root, 'dist', 'core'), {
  skipWww: true,
  copyJsModules: true,
});
await walkCopy(path.join(root, 'src', 'renderers'), path.join(root, 'dist', 'src', 'renderers'), {
  copyJsModules: false,
});
// src 下 .cjs（如 utils/system-browser.cjs）及非代码资源
await walkCopy(path.join(root, 'src'), path.join(root, 'dist', 'src'), {
  copyJsModules: false,
});

// 清理误装进 dist/core 的 node_modules（依赖应在源码 core/<名>/）
async function removeDistCoreNodeModules(distCore) {
  let entries;
  try {
    entries = await fs.readdir(distCore, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const nm = path.join(distCore, ent.name, 'node_modules');
    await fs.rm(nm, { recursive: true, force: true }).catch(() => {});
  }
}
await removeDistCoreNodeModules(path.join(root, 'dist', 'core'));

console.log('copy-runtime-assets: core (+ JS modules) + src sidecars + renderers → dist');
