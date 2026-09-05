import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLoopback127Connection,
  isLoopbackHost,
  isLoopbackAuthExempt,
  isPrivateOrLoopbackAddress,
  shouldForceAuthOnLoopbackWhenToolsRun,
} from '../../dist/src/infrastructure/http/auth.js';
import * as runtimeAuth from '../../dist/src/infrastructure/http/runtime-auth.js';

function mockRuntime(apiKey = 'k'.repeat(32)) {
  return {
    apiKey,
    _authWhitelistCache: { ref: undefined, rules: [] },
  };
}

function mockReq({
  remoteAddress = '127.0.0.1',
  ip = '127.0.0.1',
  host = '127.0.0.1:11451',
  headers = {},
  path = '/api/x',
} = {}) {
  return {
    socket: { remoteAddress },
    ip,
    path,
    headers: { host, ...headers },
    query: {},
    body: {},
  };
}

describe('HTTP 鉴权：127 回环判定', () => {
  it('127.0.0.1 为回环', () => {
    assert.equal(isLoopback127Connection('127.0.0.1'), true);
    assert.equal(isLoopback127Connection('::ffff:127.0.0.1'), true);
  });

  it('非 127 不放行', () => {
    assert.equal(isLoopback127Connection('192.168.1.1'), false);
    assert.equal(isLoopback127Connection('::1'), false);
    assert.equal(isLoopback127Connection(''), false);
  });

  it('Host 为本机才算 loopback host', () => {
    assert.equal(isLoopbackHost('127.0.0.1:11451'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('115.190.181.211:11451'), false);
    assert.equal(isLoopbackHost('example.com'), false);
  });
});

describe('限流 skip：私网/回环（与鉴权 127-only 刻意不同）', () => {
  it('鉴权不放行的私网，限流仍 skip', () => {
    for (const ip of ['192.168.1.1', '10.0.0.1', '172.16.0.1', '::1', 'fc00::1']) {
      assert.equal(isLoopback127Connection(ip), false, `auth:${ip}`);
      assert.equal(isPrivateOrLoopbackAddress(ip), true, `rate:${ip}`);
    }
  });

  it('公网不 skip 限流', () => {
    assert.equal(isPrivateOrLoopbackAddress('8.8.8.8'), false);
    assert.equal(isPrivateOrLoopbackAddress('1.1.1.1'), false);
  });

  it('127 与 mapped 回环均 skip', () => {
    assert.equal(isPrivateOrLoopbackAddress('127.0.0.1'), true);
    assert.equal(isPrivateOrLoopbackAddress('::ffff:127.0.0.1'), true);
  });
});

describe('HTTP 鉴权：isLoopbackAuthExempt 条件', () => {
  it('公网 Host + socket 回环 → 不免', () => {
    assert.equal(
      isLoopbackAuthExempt(mockReq({ host: '115.190.181.211:11451', remoteAddress: '127.0.0.1' })),
      false,
    );
  });

  it('本机 Host + socket 回环 → 条件满足', () => {
    assert.equal(
      isLoopbackAuthExempt(mockReq({ host: '127.0.0.1:11451', remoteAddress: '127.0.0.1' })),
      true,
    );
  });

  it('本机 Host + X-Forwarded-For 公网 → 不免', () => {
    assert.equal(
      isLoopbackAuthExempt(mockReq({
        host: '127.0.0.1:11451',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '8.8.8.8' },
      })),
      false,
    );
  });
});

describe('HTTP 鉴权：默认强制 Key / loopbackExempt', () => {
  it('默认本机也缺 Key 拒绝', () => {
    const runtime = mockRuntime();
    assert.equal(
      runtimeAuth.checkApiAuthorization(runtime, mockReq(), { loopbackExempt: false }),
      false,
    );
  });

  it('公网 Host 缺 Key 拒绝', () => {
    const runtime = mockRuntime();
    const req = mockReq({ host: '115.190.181.211:11451', remoteAddress: '127.0.0.1' });
    assert.equal(runtimeAuth.checkApiAuthorization(runtime, req, { loopbackExempt: false }), false);
  });

  it('公网 Host 正确 Key 通过', () => {
    const key = 'a'.repeat(32);
    const runtime = mockRuntime(key);
    const req = mockReq({
      host: '115.190.181.211:11451',
      remoteAddress: '127.0.0.1',
      headers: { 'x-api-key': key },
    });
    assert.equal(runtimeAuth.checkApiAuthorization(runtime, req, { loopbackExempt: false }), true);
  });

  it('loopbackExempt 选项开启且条件满足时本机免 Key', () => {
    const runtime = mockRuntime();
    assert.equal(
      runtimeAuth.checkApiAuthorization(runtime, mockReq(), {
        loopbackExempt: true,
        forceAuth: false,
      }),
      !shouldForceAuthOnLoopbackWhenToolsRun(),
    );
  });

  it('白名单「/」「/api」编译为 null；普通路径可匹配', () => {
    assert.equal(runtimeAuth.isDangerousAuthWhitelistPrefix('/'), true);
    assert.equal(runtimeAuth.isDangerousAuthWhitelistPrefix('/api'), true);
    assert.equal(runtimeAuth.compileAuthWhitelistRule('/'), null);
    assert.equal(runtimeAuth.compileAuthWhitelistRule('/api'), null);
    assert.equal(runtimeAuth.compileAuthWhitelistRule('/api*'), null);

    const health = runtimeAuth.compileAuthWhitelistRule('/health');
    assert.equal(health?.type, 'exact');
    assert.equal(runtimeAuth.matchWhitelistRule(health, '/health'), true);
    assert.equal(runtimeAuth.matchWhitelistRule(health, '/healthz'), false);
    assert.equal(runtimeAuth.matchWhitelistRule(health, '/api/system/overview'), false);

    const pub = runtimeAuth.compileAuthWhitelistRule('/api/public*');
    assert.equal(pub?.type, 'prefix');
    assert.equal(runtimeAuth.matchWhitelistRule(pub, '/api/public/x'), true);
    assert.equal(runtimeAuth.matchWhitelistRule(pub, '/api/system/overview'), false);
  });

  it('错误 Key（如 111）拒绝', () => {
    const runtime = mockRuntime('a'.repeat(32));
    const req = mockReq({
      host: '115.190.181.211:11451',
      remoteAddress: '8.8.8.8',
      ip: '8.8.8.8',
      headers: { 'x-api-key': '111' },
    });
    assert.equal(runtimeAuth.checkApiAuthorization(runtime, req, { loopbackExempt: false }), false);
  });
});

describe('HTTP 鉴权：forceAuth', () => {
  it('forceAuth 时 loopback 缺 Key 拒绝', () => {
    const runtime = mockRuntime();
    assert.equal(runtimeAuth.checkApiAuthorization(runtime, mockReq(), { forceAuth: true }), false);
  });

  it('forceAuth 时正确 Key 通过', () => {
    const key = 'a'.repeat(32);
    const runtime = mockRuntime(key);
    const req = mockReq({ headers: { 'x-api-key': key } });
    assert.equal(runtimeAuth.checkApiAuthorization(runtime, req, { forceAuth: true }), true);
  });
});

describe('getAuthModePublicSnapshot', () => {
  it('有密钥时 requiresKey=true', () => {
    const snap = runtimeAuth.getAuthModePublicSnapshot(mockRuntime());
    assert.equal(snap.apiKeyEnabled, true);
    assert.equal(snap.requiresKey, true);
  });

  it('无密钥时 requiresKey=false', () => {
    const snap = runtimeAuth.getAuthModePublicSnapshot(mockRuntime(''));
    assert.equal(snap.requiresKey, false);
  });
});
