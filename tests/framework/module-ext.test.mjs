/**
 * preferSourceModules / stripModuleExt / dist 优先 .js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDeclarationFile,
  isDistPath,
  moduleFileKey,
  preferSourceModules,
  resolveModuleInDir,
  stripModuleExt,
} from '#utils/module-ext.js';

describe('module-ext', () => {
  it('preferSourceModules keeps .ts over .js for same stem (源码树)', () => {
    const out = preferSourceModules([
      'C:/core/plugin/foo.js',
      'C:/core/plugin/foo.ts',
      'C:/core/plugin/bar.js',
    ]);
    assert.deepEqual(
      out.map((p) => p.replace(/\\/g, '/')),
      ['C:/core/plugin/bar.js', 'C:/core/plugin/foo.ts'],
    );
  });

  it('preferSourceModules keeps .js over .ts under dist/ (防漏载)', () => {
    const out = preferSourceModules([
      'D:/code/XRK-AGT/dist/core/system-Core/plugin/foo.ts',
      'D:/code/XRK-AGT/dist/core/system-Core/plugin/foo.js',
      'D:/code/XRK-AGT/dist/core/system-Core/plugin/bar.js',
    ]);
    assert.deepEqual(
      out.map((p) => p.replace(/\\/g, '/')),
      [
        'D:/code/XRK-AGT/dist/core/system-Core/plugin/bar.js',
        'D:/code/XRK-AGT/dist/core/system-Core/plugin/foo.js',
      ],
    );
  });

  it('preferSourceModules skips .d.ts', () => {
    const out = preferSourceModules([
      'C:/core/plugin/foo.d.ts',
      'C:/core/plugin/foo.js',
    ]);
    assert.deepEqual(
      out.map((p) => p.replace(/\\/g, '/')),
      ['C:/core/plugin/foo.js'],
    );
  });

  it('stripModuleExt / moduleFileKey handle .ts and .js', () => {
    assert.equal(stripModuleExt('a/b/c.ts'), 'a/b/c');
    assert.equal(moduleFileKey('a/b/c.ts'), 'c');
    assert.equal(moduleFileKey('a/b/c.js'), 'c');
    assert.equal(isDeclarationFile('foo.d.ts'), true);
    assert.equal(isDistPath('D:\\x\\dist\\core\\a.js'), true);
  });

  it('resolveModuleInDir prefers .js under dist', () => {
    const hits = new Set(['D:/repo/dist/core/x/index.js', 'D:/repo/dist/core/x/index.ts']);
    const hit = resolveModuleInDir('D:/repo/dist/core/x', 'index', (p) =>
      hits.has(p.replace(/\\/g, '/')),
    );
    assert.equal(hit?.replace(/\\/g, '/'), 'D:/repo/dist/core/x/index.js');
  });
});
