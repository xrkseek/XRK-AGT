import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getConfiguredServerUrl,
  getProxyConfig,
  getPublicServerUrl,
  getServerHost,
  isHttpsEnabled,
} from '../../dist/src/infrastructure/http/runtime-net.js';

describe('runtime-net 配置访问', () => {
  it('getServerHost / getProxyConfig / isHttpsEnabled 返回稳定类型', () => {
    assert.equal(typeof getServerHost(), 'string');
    assert.ok(getServerHost().length > 0);
    assert.equal(typeof getProxyConfig(), 'object');
    assert.equal(typeof isHttpsEnabled(), 'boolean');
    assert.equal(typeof getConfiguredServerUrl(), 'string');
  });

  it('getPublicServerUrl：override 优先；无公网配置时可能为空串', () => {
    const runtime = { proxyEnabled: false };
    const withOverride = getPublicServerUrl(runtime, 'https://example.test/');
    assert.equal(withOverride, 'https://example.test');
    const emptyish = getPublicServerUrl(runtime, '');
    assert.equal(typeof emptyish, 'string');
  });
});
