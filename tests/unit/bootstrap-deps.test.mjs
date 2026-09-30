import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPackageInstalled, getBrowserStatus } from '#utils/bootstrap-deps.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nodeModules = path.join(root, 'node_modules');

describe('bootstrap-deps', () => {
  it('isPackageInstalled 识别已装 / 缺失依赖', () => {
    assert.ok(isPackageInstalled('pino', nodeModules, root));
    assert.equal(isPackageInstalled('__not_a_real_pkg__', nodeModules, root), false);
  });

  it('getBrowserStatus 返回结构', async () => {
    const status = await getBrowserStatus(root);
    assert.equal(typeof status.playwrightInstalled, 'boolean');
    assert.equal(typeof status.browserInstalled, 'boolean');
  });
});
