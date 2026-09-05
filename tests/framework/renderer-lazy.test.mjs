import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('RendererLoader 懒加载', () => {
  it('import 时不预加载浏览器', async () => {
    const { default: loader } = await import('../../dist/src/infrastructure/renderer/loader.js');
    assert.equal(loader.renderers.size, 0);
    assert.equal(loader._loadPromise, null);
  });
});
