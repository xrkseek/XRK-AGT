/**
 * src/utils/path-guards 行为测试（工作区 / Skills 路径边界的安全闸门）。
 *
 * 覆盖门禁里此模块此前无任何断言（被动覆盖率 77.78% 全靠 dist 采集），
 * 这里按平台分支补齐：win32 normalize / UNC / 大小写、前缀欺骗（sibling 同名目录）、
 * 路径穿越、以及 realpathSyncOrResolve 的异常回退。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { realpathSyncOrResolve, isPathInside } from '../../dist/src/utils/path-guards.js';

const isWin = process.platform === 'win32';

describe('isPathInside 前缀欺骗防护', () => {
  it('自身与子路径为真', () => {
    const root = path.resolve(isWin ? 'C:\\work\\root' : '/work/root');
    assert.equal(isPathInside(root, root), true);
    assert.equal(
      isPathInside(root, path.join(root, 'a', 'b.txt')),
      true,
      '多级子路径应在内',
    );
  });

  it('同名前缀兄弟目录为假（防 prefix 绕过）', () => {
    const root = path.resolve(isWin ? 'C:\\work\\root' : '/work/root');
    assert.equal(
      isPathInside(root, `${root}-evil`),
      false,
      '"root-evil" 不在 "root" 内：字符串前缀匹配会误判为真',
    );
    assert.equal(isPathInside(root, path.join(path.dirname(root), 'other')), false);
  });

  it('父目录与路径穿越为假', () => {
    const root = path.resolve(isWin ? 'C:\\work\\root' : '/work/root');
    assert.equal(isPathInside(root, path.dirname(root)), false);
    assert.equal(
      isPathInside(root, path.join(root, '..', '..', 'etc', 'passwd')),
      false,
      '.. 穿越出根必须为假',
    );
  });
});

describe('isPathInside 平台归一化', () => {
  it('win32：大小写不敏感 + 正斜杠等价', (t) => {
    if (!isWin) return t.skip('win32 专属');
    const root = 'C:\\Work\\Root';
    assert.equal(isPathInside(root, 'c:\\work\\root\\sub'), true, '盘符/目录大小写差异应等价');
    assert.equal(isPathInside(root, 'C:/Work/Root/sub'), true, '正斜杠应等价于反斜杠');
  });

  it('win32：UNC 路径比较', (t) => {
    if (!isWin) return t.skip('win32 专属');
    assert.equal(
      isPathInside('\\\\server\\share\\ws', '\\\\SERVER\\share\\ws\\a.txt'),
      true,
      'UNC 主机名大小写不敏感',
    );
    assert.equal(isPathInside('\\\\server\\share\\ws', '\\\\server\\share\\other'), false);
  });

  it('posix：大小写敏感', (t) => {
    if (isWin) return t.skip('posix 专属');
    assert.equal(isPathInside('/work/root', '/work/root/sub'), true);
    assert.equal(
      isPathInside('/work/root', '/work/Root/sub'),
      false,
      'posix 路径大小写敏感，/work/Root 与 /work/root 无关',
    );
  });
});

describe('realpathSyncOrResolve', () => {
  it('存在的路径走 realpath（解析符号链接）', () => {
    const dir = path.resolve('tests');
    assert.equal(realpathSyncOrResolve(dir), fs.realpathSync(dir));
  });

  it('不存在的路径回退 path.resolve（不抛）', () => {
    const missing = path.resolve('tests', '__no_such_dir__', 'x.txt');
    assert.equal(realpathSyncOrResolve(missing), missing);
  });

  it('非法输入回退而非崩溃', () => {
    // 空串 realpathSync 抛 ENOENT → 应回退到 path.resolve('')（当前工作目录）
    assert.equal(typeof realpathSyncOrResolve(''), 'string');
    assert.equal(
      realpathSyncOrResolve(''),
      path.resolve(''),
    );
  });
});