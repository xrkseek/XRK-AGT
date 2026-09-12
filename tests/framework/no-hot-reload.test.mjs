/**
 * 锁定：`src/utils/hot-reload-base` 已有意删除（ADR-0004）。
 * 勿默默加回 HotReloadBase / chokidar / 文件监视热重载。
 * 门禁：列入 `tests/run.mjs` → `fast`（`pnpm test:fast`）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const FORBIDDEN_BASE = [
  'src/utils/hot-reload-base.js',
  'src/utils/hot-reload-base.ts',
  'dist/src/utils/hot-reload-base.js',
  'dist/src/utils/hot-reload-base.d.ts',
];

function walkSourceFiles(dir, exts, skipDirNames) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (skipDirNames.has(ent.name)) continue;
        stack.push(full);
        continue;
      }
      if (exts.has(path.extname(ent.name))) out.push(full);
    }
  }
  return out;
}

describe('no hot-reload', () => {
  it('does not ship hot-reload-base source or dist', () => {
    for (const rel of FORBIDDEN_BASE) {
      assert.equal(fs.existsSync(path.join(root, rel)), false, `forbidden: ${rel}`);
    }
  });

  it('does not depend on chokidar', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies?.chokidar, undefined);
    assert.equal(pkg.devDependencies?.chokidar, undefined);
    assert.equal(pkg.optionalDependencies?.chokidar, undefined);
  });

  it('src has no import of hot-reload-base / HotReloadBase', () => {
    const files = walkSourceFiles(
      path.join(root, 'src'),
      new Set(['.ts', '.js', '.mjs', '.cjs']),
      new Set(['node_modules', 'dist']),
    );
    /** @type {string[]} */
    const hits = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (/hot-reload-base/.test(text) || /\bHotReloadBase\b/.test(text)) {
        hits.push(path.relative(root, file).replace(/\\/g, '/'));
      }
    }
    assert.deepEqual(hits, [], `forbidden references:\n${hits.join('\n')}`);
  });

  it('runtime-boot does not enable loader watches', () => {
    const boot = fs.readFileSync(
      path.join(root, 'src/infrastructure/http/runtime-boot.ts'),
      'utf8',
    );
    assert.equal(/\bPluginLoader\.watch\s*\(/.test(boot), false);
    assert.equal(/\bHttpApiLoader\.watch\s*\(/.test(boot), false);
    assert.equal(/\bAiWorkflowLoader\.watch\s*\(/.test(boot), false);
    assert.equal(/\bCommonConfigRegistry\.watch\s*\(/.test(boot), false);
  });

  it('loader-hot-reload is unload helpers only (no chokidar / HotReloadBase)', () => {
    const p = path.join(root, 'src/infrastructure/plugins/loader-hot-reload.ts');
    assert.equal(fs.existsSync(p), true);
    const src = fs.readFileSync(p, 'utf8');
    assert.equal(/chokidar/.test(src), false);
    assert.equal(/\bHotReloadBase\b/.test(src), false);
    assert.equal(/from\s+['"]#utils\/hot-reload-base/.test(src), false);
  });
});
