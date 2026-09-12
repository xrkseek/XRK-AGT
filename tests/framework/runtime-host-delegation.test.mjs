/**
 * runtime Host 委托面：鉴权 / WS / 监听 / 代理
 * 对照原版行为，用 mock Host 验证薄委托可独立调用。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as runtimeAuth from '../../dist/src/infrastructure/http/runtime-auth.js';
import * as runtimeWs from '../../dist/src/infrastructure/http/runtime-ws.js';
import * as runtimeListen from '../../dist/src/infrastructure/http/runtime-listen.js';
import * as runtimeProxy from '../../dist/src/infrastructure/http/runtime-proxy.js';

function authHost(apiKey = 'k'.repeat(32)) {
  return {
    apiKey,
    _authWhitelistCache: { ref: undefined, rules: [] },
  };
}

function wsHost(overrides = {}) {
  return {
    wsf: Object.create(null),
    wss: { handleUpgrade() {} },
    _wsConnections: new Map(),
    _wsHeartbeatInterval: null,
    checkApiAuthorization: () => true,
    ...overrides,
  };
}

describe('runtime-host：鉴权 Host', () => {
  it('checkApiAuthorization 接受 RuntimeAuthHost 形状', () => {
    const key = 'a'.repeat(32);
    const runtime = authHost(key);
    const req = {
      path: '/api/x',
      ip: '8.8.8.8',
      socket: { remoteAddress: '8.8.8.8' },
      headers: { host: 'example.com', 'x-api-key': key },
      query: {},
    };
    assert.equal(
      runtimeAuth.checkApiAuthorization(runtime, req, { loopbackExempt: false }),
      true,
    );
  });

  it('无密钥 requiresKey=false', () => {
    const snap = runtimeAuth.getAuthModePublicSnapshot(authHost(''));
    assert.equal(snap.requiresKey, false);
  });
});

describe('runtime-host：WS Host', () => {
  it('getWsHandlersForPath / isWsPathSkipAuth', () => {
    const handler = () => {};
    const runtime = wsHost({
      wsf: {
        chat: [{ handler, skipAuth: true }],
        echo: [handler],
      },
    });
    assert.equal(runtimeWs.getWsHandlersForPath(runtime, 'chat').length, 1);
    assert.equal(runtimeWs.isWsPathSkipAuth(runtime, 'chat'), true);
    assert.equal(runtimeWs.isWsPathSkipAuth(runtime, 'echo'), false);
    assert.equal(runtimeWs.shouldRequireWsApiAuth(runtime, 'chat'), false);
  });

  it('getWebSocketStats / stopWebSocketHeartbeat', () => {
    const runtime = wsHost();
    runtime._wsConnections.set('1', {
      path: 'chat',
      connectedAt: 100,
      lastPing: Date.now(),
      readyState: 1,
      OPEN: 1,
      ping() {},
      terminate() {},
    });
    runtime._wsConnections.set('2', {
      path: 'chat',
      connectedAt: 200,
      lastPing: Date.now(),
      readyState: 1,
      OPEN: 1,
      ping() {},
      terminate() {},
    });
    const stats = runtimeWs.getWebSocketStats(runtime);
    assert.equal(stats.total, 2);
    assert.equal(stats.byPath.chat, 2);
    assert.equal(stats.oldest?.id, '1');
    assert.equal(stats.newest?.id, '2');

    runtime._wsHeartbeatInterval = setInterval(() => {}, 60_000);
    runtimeWs.stopWebSocketHeartbeat(runtime);
    assert.equal(runtime._wsHeartbeatInterval, null);
  });

  it('未知 WS 路径写 404 并 destroy', () => {
    const runtime = wsHost();
    let written = '';
    let destroyed = false;
    const socket = {
      write(chunk) {
        written += chunk;
      },
      destroy() {
        destroyed = true;
      },
    };
    const req = {
      url: '/missing',
      headers: { host: '127.0.0.1:1', 'sec-websocket-key': 'x' },
      socket: {
        remoteAddress: '127.0.0.1',
        remotePort: 1,
        localAddress: '127.0.0.1',
        localPort: 1,
      },
    };
    runtimeWs.wsConnect(runtime, req, socket, Buffer.alloc(0));
    assert.match(written, /404/);
    assert.equal(destroyed, true);
  });
});

describe('runtime-host：监听 Host', () => {
  it('getServerUrl 无代理时回落到本机端口', () => {
    const runtime = {
      proxyEnabled: false,
      actualPort: 18086,
      actualHttpsPort: null,
      httpPort: 18086,
      httpsPort: null,
      server: null,
      httpsServer: null,
      proxyServer: null,
      proxyHttpsServer: null,
      express: {},
      _wsConnections: new Map(),
      _stopWebSocketHeartbeat() {},
      _handleServerError() {},
      wsConnect() {},
      redisExit() {},
    };
    const url = runtimeListen.getServerUrl(runtime);
    assert.equal(typeof url, 'string');
    assert.ok(url.includes('127.0.0.1') || url.startsWith('http'));
  });
});

describe('runtime-host：代理 Host', () => {
  it('extractClientIP 优先 CDN / X-Forwarded-For', () => {
    const runtime = {
      actualPort: 8080,
      actualHttpsPort: null,
      proxyApp: null,
      proxyServer: null,
      proxyHttpsServer: null,
      proxyMiddlewares: new Map(),
      domainConfigs: new Map(),
      sslContexts: new Map(),
      httpBusiness: {
        cdnManager: {
          isCDNRequest: () => ({ ip: '1.2.3.4' }),
        },
        selectProxyUpstream: () => null,
        proxyManager: {
          incrementConnections() {},
          decrementConnections() {},
          markUpstreamSuccess() {},
        },
        markProxyFailure() {},
      },
    };
    assert.equal(runtimeProxy.extractClientIP(runtime, { headers: {} }), '1.2.3.4');

    runtime.httpBusiness.cdnManager.isCDNRequest = () => null;
    assert.equal(
      runtimeProxy.extractClientIP(runtime, {
        headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8' },
      }),
      '9.9.9.9',
    );
  });

  it('findDomainConfig 支持通配域名与 subdomain 重写', () => {
    const runtime = {
      domainConfigs: new Map([
        [
          '*.example.com',
          {
            domain: '*.example.com',
            target: 'http://127.0.0.1:1',
            rewritePath: { from: '/', to: '/${subdomain}/' },
          },
        ],
      ]),
      sslContexts: new Map(),
      proxyMiddlewares: new Map(),
      proxyApp: null,
      proxyServer: null,
      proxyHttpsServer: null,
      actualPort: 1,
      actualHttpsPort: null,
      httpBusiness: {
        cdnManager: { isCDNRequest: () => null },
        selectProxyUpstream: () => null,
        proxyManager: {
          incrementConnections() {},
          decrementConnections() {},
          markUpstreamSuccess() {},
        },
        markProxyFailure() {},
      },
    };
    const cfg = runtimeProxy.findDomainConfig(runtime, 'a.example.com');
    assert.ok(cfg);
    assert.equal(cfg.subdomain, 'a');
    assert.equal(cfg.rewritePath.to, '/a/');
  });
});
