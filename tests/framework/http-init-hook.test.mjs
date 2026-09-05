import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import HttpApi from '../../dist/src/infrastructure/http/http.js';

describe('HttpApi initHook 绑定', () => {
  it('initHook 内 this 为 HttpApi 实例', async () => {
    let capturedThis;
    const api = new HttpApi({
      name: 'hook-test',
      routes: [],
      init(app, bot) {
        capturedThis = this;
        assert.equal(typeof this.wrapHandler, 'function');
      }
    });
    await api.init({ use() {}, get() {}, post() {} }, {});
    assert.strictEqual(capturedThis, api);
  });
});
