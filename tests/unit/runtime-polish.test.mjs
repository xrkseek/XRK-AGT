/**
 * 混沌钩子 / 静态隐藏规则（无绑定恐吓逻辑）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachChaosMiddleware, chaosEnabled } from '../../dist/src/infrastructure/http/runtime-chaos.js';
import { isHiddenStaticPath } from '../../dist/src/infrastructure/http/runtime-static.js';

describe('runtime-chaos 服务端注入', () => {
  it('errorRate=1 时目标路径返回 503（mock）', async () => {
    const prev = {
      en: process.env.XRK_CHAOS_ENABLED,
      er: process.env.XRK_CHAOS_ERROR_RATE,
      lat: process.env.XRK_CHAOS_LATENCY_MS,
      paths: process.env.XRK_CHAOS_PATHS,
      seed: process.env.XRK_CHAOS_SEED,
    };
    process.env.XRK_CHAOS_ENABLED = '1';
    process.env.XRK_CHAOS_ERROR_RATE = '1';
    process.env.XRK_CHAOS_LATENCY_MS = '0';
    process.env.XRK_CHAOS_PATHS = '/health';
    process.env.XRK_CHAOS_SEED = 'unit-chaos';
    assert.equal(chaosEnabled(), true);

    /** @type {((req: any, res: any, next: any) => any)[]} */
    const stack = [];
    const app = {
      use(fn) {
        stack.push(fn);
      },
    };
    attachChaosMiddleware(/** @type {any} */ (app));
    assert.equal(stack.length, 1);
    const mw = stack[0];

    const hit = await new Promise((resolve) => {
      const res = {
        headersSent: false,
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          resolve({ status: this.statusCode, body: payload, nextCalled: false });
        },
      };
      mw({ path: '/health', requestId: 't1' }, res, () => {
        resolve({ status: 200, body: null, nextCalled: true });
      });
    });
    assert.equal(hit.status, 503);
    assert.equal(hit.body?.error, 'chaos_injected');
    assert.equal(hit.nextCalled, false);

    const miss = await new Promise((resolve) => {
      mw({ path: '/other' }, { headersSent: false }, () => resolve({ nextCalled: true }));
    });
    assert.equal(miss.nextCalled, true);

    for (const [k, v] of Object.entries({
      XRK_CHAOS_ENABLED: prev.en,
      XRK_CHAOS_ERROR_RATE: prev.er,
      XRK_CHAOS_LATENCY_MS: prev.lat,
      XRK_CHAOS_PATHS: prev.paths,
      XRK_CHAOS_SEED: prev.seed,
    })) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('未启用时不挂载', () => {
    delete process.env.XRK_CHAOS_ENABLED;
    const stack = [];
    attachChaosMiddleware(/** @type {any} */ ({ use: (fn) => stack.push(fn) }));
    assert.equal(stack.length, 0);
  });
});

describe('runtime-static 隐藏规则', () => {
  it('默认隐藏 .git / node_modules', () => {
    const runtime = { _compiledHiddenFileMatchers: null };
    assert.equal(isHiddenStaticPath(runtime, '/foo/.git/config'), true);
    assert.equal(isHiddenStaticPath(runtime, '/node_modules/x'), true);
    assert.equal(isHiddenStaticPath(runtime, '/xrk/index.html'), false);
  });
});
