/**
 * www 静态根解析的越界防护。
 *
 * resolveWwwStaticRoot 会在 appDir 下按候选目录找产物（dist/build/out…），
 * 这些相对路径来自 sign.json（可写配置），必须挡住「解析后逃出 appDir」的取值。
 *
 * 防护由 src/infrastructure/http/www-app-resolve.ts 的 isInsideAppDir 提供，
 * 它是 **realpath 归一 + isPathInside 的 Windows 归一** 两层：
 *   - 只有 realpath 能挡住 junction/symlink（isPathInside 本身不做 realpath）
 *   - 只有 isPathInside 能挡住 Windows 大小写与 \\?\ 前缀差异
 * 少任何一层都会漏，所以这里分别用 junction 与大小写两种用例锁住。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { resolveWwwStaticRoot } = await import(
  '../../dist/src/infrastructure/http/www-app-resolve.js'
);

let root;
let appDir;
let outsideDir;

function writeIndex(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'www-resolve-'));
  appDir = path.join(root, 'app');
  outsideDir = path.join(root, 'outside');
  writeIndex(path.join(appDir, 'dist'));
  writeIndex(outsideDir);
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveWwwStaticRoot 的越界防护', () => {
  it('产物在 appDir 内 → 正常挂载', () => {
    const r = resolveWwwStaticRoot(appDir, { staticRoot: 'dist' });
    assert.equal(path.resolve(r.root), path.resolve(appDir, 'dist'));
  });

  it('无 sign 时挂应用目录本体', () => {
    const r = resolveWwwStaticRoot(appDir, null);
    assert.equal(path.resolve(r.root), path.resolve(appDir));
  });

  it('staticRoot 用 .. 逃出 appDir → 拒绝，不返回外部目录', () => {
    // 外部目录确实存在 index.html，若防护失效这里就会返回它
    const r = resolveWwwStaticRoot(appDir, { staticRoot: '../outside' });
    assert.notEqual(
      path.resolve(r.root),
      path.resolve(outsideDir),
      'staticRoot=../outside 逃出了 appDir，必须被拒绝',
    );
  });

  it('候选目录穿越（dist/../../outside）→ 拒绝', () => {
    const r = resolveWwwStaticRoot(appDir, { staticRoot: 'dist/../../outside' });
    assert.notEqual(path.resolve(r.root), path.resolve(outsideDir), '路径穿越必须被拒绝');
  });

  it('junction 指向 appDir 外 → 拒绝（realpath 归一的关键防线）', (t) => {
    const linkPath = path.join(appDir, 'link');
    try {
      // 注意：不能先 mkdir(linkPath)，junction 要求目标路径不存在，否则 EEXIST
      fs.symlinkSync(outsideDir, linkPath, 'junction');
    } catch (err) {
      // 创建不了 junction 的环境（非 Windows / 权限受限）跳过，但必须说明原因
      t.skip(`无法创建 junction：${err.code || err.message}`);
      return;
    }
    try {
      const r = resolveWwwStaticRoot(appDir, { staticRoot: 'link' });
      assert.notEqual(
        path.resolve(r.root),
        path.resolve(outsideDir),
        'junction 指向 appDir 外，realpath 后仍逃逸，必须被拒绝',
      );
    } finally {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  });

  it('Windows 路径大小写差异不误判为越界', (t) => {
    if (process.platform !== 'win32') {
      t.skip('仅 Windows 有效');
      return;
    }
    const upper = appDir.toUpperCase();
    const r = resolveWwwStaticRoot(upper, { staticRoot: 'dist' });
    assert.equal(
      path.resolve(r.root).toLowerCase(),
      path.resolve(appDir, 'dist').toLowerCase(),
      'Windows 文件系统大小写不敏感，全大写 appDir 应命中同一产物',
    );
  });
});