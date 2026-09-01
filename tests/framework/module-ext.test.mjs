/**
 * preferSourceModules / stripModuleExt smoke.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  moduleFileKey,
  preferSourceModules,
  stripModuleExt,
} from '../../src/utils/module-ext.ts';

describe('module-ext', () => {
  it('preferSourceModules keeps .ts over .js for same stem', () => {
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

  it('stripModuleExt / moduleFileKey handle .ts', () => {
    assert.equal(stripModuleExt('a/b/c.ts'), 'a/b/c');
    assert.equal(moduleFileKey('a/b/c.ts'), 'c');
  });
});
