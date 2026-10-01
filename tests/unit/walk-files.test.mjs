/**
 * walkFiles 的行为契约。
 *
 * 这四条遍历（rules 索引、skills 指纹、skills 文档扫描、SKILL.md 扫描）此前
 * 各有一份同构实现，差异藏在「跳隐藏 / 跳 node_modules / 深度上限 / 条数上限」
 * 四个维度里，各自维护时已经漏过一次（skills 指纹那份不跳 node_modules）。
 * 这里把每个维度的语义都钉住。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { walkFiles } = await import('../../dist/src/utils/walk-files.js');

let root;
const rel = (...p) => path.join(root, ...p);

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-files-'));
  const mk = p => {
    fs.mkdirSync(path.dirname(rel(p)), { recursive: true });
    fs.writeFileSync(rel(p), 'x');
  };
  mk('top.md');
  mk('notes.txt');
  mk('a/one.md');
  mk('a/b/two.md');
  mk('a/b/c/three.md');
  mk('a/b/c/d/four.md');
  mk('.hidden/secret.md');
  mk('node_modules/pkg/index.md');
  mk('node_modules/pkg/nested/deep.md');
  mk('.dotfile.md');
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const names = (list, dir = root) =>
  list.map((f) => path.relative(dir, f).replace(/\\/g, '/')).sort();

describe('walkFiles', () => {
  it('默认跳隐藏项与 node_modules', () => {
    const got = names(walkFiles(root));
    assert.ok(got.includes('top.md'), '普通文件应收');
    assert.ok(got.includes('a/b/c/d/four.md'), '深层文件应收');
    assert.ok(!got.some((f) => f.startsWith('node_modules/')), 'node_modules 必须跳过');
    assert.ok(!got.some((f) => f.startsWith('.hidden/')), '隐藏目录必须跳过');
    assert.ok(!got.includes('.dotfile.md'), '隐藏文件必须跳过');
  });

  it('maxDepth 限制递归层数（根为 0）', () => {
    assert.deepEqual(names(walkFiles(root, { maxDepth: 0 })), ['notes.txt', 'top.md']);
    assert.deepEqual(names(walkFiles(root, { maxDepth: 1 })), [
      'a/one.md',
      'notes.txt',
      'top.md',
    ]);
    // 深度 2 才能到 a/b/two.md
    assert.ok(names(walkFiles(root, { maxDepth: 2 })).includes('a/b/two.md'));
    assert.ok(!names(walkFiles(root, { maxDepth: 2 })).includes('a/b/c/three.md'));
  });

  it('maxFiles 限制收集条数', () => {
    assert.equal(walkFiles(root, { maxFiles: 2 }).length, 2);
    // 条数上限为 0 → 什么都不收
    assert.deepEqual(walkFiles(root, { maxFiles: 0 }), []);
  });

  it('match 只收命中的文件', () => {
    const md = names(walkFiles(root, { match: (n) => n.endsWith('.md') }));
    assert.ok(md.includes('top.md'));
    assert.ok(md.includes('a/one.md'));
    assert.ok(!md.includes('notes.txt'), '非 md 不应收');
  });

  it('skipDirs 可自定义（默认只跳 node_modules）', () => {
    const got = names(walkFiles(root, { skipDirs: new Set(['a']) }));
    assert.ok(got.includes('top.md'));
    assert.ok(!got.some((f) => f.startsWith('a/')), '自定义跳过的目录应被排除');
    // 默认集合不含 .git，源码树里的 .git 目录会被遍历进去
    const withGit = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-git-'));
    try {
      fs.mkdirSync(path.join(withGit, '.git', 'refs'), { recursive: true });
      fs.writeFileSync(path.join(withGit, '.git', 'refs', 'r.txt'), 'x');
      assert.equal(
        walkFiles(withGit).length,
        0,
        '默认不跳 .git：需要显式传 skipDirs（调用方按需自行传入）',
      );
    } finally {
      fs.rmSync(withGit, { recursive: true, force: true });
    }
  });

  it('目录不可读时静默跳过，不抛异常', () => {
    const missing = walkFiles(path.join(root, 'does-not-exist'));
    assert.deepEqual(missing, []);
  });

  it('返回绝对路径', () => {
    const [first] = walkFiles(root, { maxFiles: 1 });
    assert.ok(path.isAbsolute(first), `应返回绝对路径，实际 ${first}`);
  });
});