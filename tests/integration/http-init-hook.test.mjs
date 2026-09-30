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

  it('registerRoutes 以 app 为 this 调用 verb（避免 Express lazyrouter 未初始化）', async () => {
    let getThis;
    const api = new HttpApi({
      name: 'route-this-test',
      routes: [{ method: 'get', path: '/ping', handler: (_req, res) => res.end('ok') }],
    });
    await api.init(
      {
        use() {},
        get(...args) {
          getThis = this;
          return this;
        },
        post() {
          return this;
        },
      },
      {}
    );
    assert.equal(typeof getThis?.get, 'function');
    assert.notEqual(getThis, api);
  });
});
