import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESERVED_ROOT_SEGMENTS } from '../../dist/src/infrastructure/http/mount-core-www.js';
import {
  isActiveFrontendSign,
  isWwwSignedStaticRootOk,
  readWwwSignFile,
  resolveWwwAppMount,
  resolveWwwAppStaticRoot,
  resolveWwwPublicMountPath,
  resolveWwwStaticRoot,
  shouldProxyFrontend,
} from '../../dist/src/infrastructure/http/www-app-resolve.js';
import {
  mergePreferDefined,
  resolveWwwMountOverlays,
  applyWwwStaticOverlay,
} from '../../dist/src/infrastructure/http/www-sign-merge.js';

describe('mount-core-www 保留根段', () => {
  it('含框架与历史冲突名 shared', () => {
    for (const seg of ['api', 'core', 'media', 'uploads', 'File', 'shared']) {
      assert.ok(RESERVED_ROOT_SEGMENTS.includes(seg), seg);
    }
  });
});

describe('www-app-resolve', () => {
  /** @returns {string} */
  function tmpApp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'xrk-www-app-'));
  }

  function writeSign(dir, obj) {
    fs.writeFileSync(path.join(dir, 'sign.json'), JSON.stringify(obj));
  }

  it('shouldProxyFrontend：enabled false / serve static 不反代', () => {
    assert.equal(shouldProxyFrontend(null), false);
    assert.equal(shouldProxyFrontend({ enabled: false }), false);
    assert.equal(shouldProxyFrontend({ enabled: true, serve: 'static' }), false);
    assert.equal(shouldProxyFrontend({ enabled: true, serve: 'dist' }), false);
    assert.equal(shouldProxyFrontend({ enabled: true }), true);
    assert.equal(shouldProxyFrontend({ enabled: true, serve: 'proxy' }), true);
  });

  it('零配置静态：无 sign → URL=目录名，不挂 dist', () => {
    const parent = tmpApp();
    const appDir = path.join(parent, 'xrk');
    fs.mkdirSync(appDir);
    const dist = path.join(appDir, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(appDir, 'index.html'), '<html>root</html>');

    const d = resolveWwwAppMount(appDir);
    assert.equal(d.kind, 'plain');
    assert.equal(d.mode, 'static');
    assert.equal(d.mountPath, '/xrk');
    assert.equal(d.staticRoot, appDir);
    assert.equal(resolveWwwPublicMountPath('xrk', null), '/xrk');
    assert.equal(resolveWwwAppStaticRoot(appDir), appDir);

    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('前端工程：proxy.mount 优先于目录名，静态挂 dist', () => {
    assert.equal(
      resolveWwwPublicMountPath('frontend-example', {
        id: 'example',
        proxy: { mount: '/example' },
      }),
      '/example'
    );
    assert.equal(
      resolveWwwPublicMountPath('frontend-example', { id: 'example' }),
      '/example'
    );

    const parent = tmpApp();
    const appDir = path.join(parent, 'frontend-example');
    fs.mkdirSync(appDir);
    writeSign(appDir, {
      enabled: false,
      serve: 'static',
      id: 'example',
      proxy: { mount: '/example' },
    });
    fs.mkdirSync(path.join(appDir, 'dist'));
    fs.writeFileSync(path.join(appDir, 'dist', 'index.html'), '<html></html>');
    const d = resolveWwwAppMount(appDir);
    assert.equal(d.kind, 'signed');
    assert.equal(d.mountPath, '/example');
    assert.equal(d.mode, 'static');
    assert.equal(d.staticRoot, path.join(appDir, 'dist'));
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('纯静态有 sign：staticRoot=. 挂目录并可改 URL', () => {
    const dir = tmpApp();
    writeSign(dir, {
      enabled: false,
      serve: 'static',
      staticRoot: '.',
      buildOnStart: false,
      id: 'help',
      proxy: { mount: '/help-docs' },
    });
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>help</html>');
    const d = resolveWwwAppMount(dir);
    assert.equal(d.kind, 'signed');
    assert.equal(d.mode, 'static');
    assert.equal(d.mountPath, '/help-docs');
    assert.equal(d.staticRoot, dir);
    assert.equal(resolveWwwStaticRoot(dir, d.sign).via, '.');
    assert.equal(isWwwSignedStaticRootOk(dir, d.sign, { root: dir, via: '.' }), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sign↔server 合并：sign 已写优先，未写回落主服', () => {
    const server = {
      static: { cacheTime: '1d', index: ['index.html'], immutable: true },
      rateLimit: {
        enabled: true,
        global: { windowMs: 900000, max: 1000, message: '全局过频' },
      },
    };
    const overlays = resolveWwwMountOverlays(
      {
        static: { cacheTime: '1h' },
        rateLimit: { max: 50 },
      },
      server,
    );
    assert.equal(overlays.static.cacheTime, '1h');
    assert.deepEqual(overlays.static.index, ['index.html']);
    assert.equal(overlays.static.immutable, true);
    assert.equal(overlays.rateLimit?.enabled, true);
    assert.equal(overlays.rateLimit?.max, 50);
    assert.equal(overlays.rateLimit?.windowMs, 900000);
    assert.equal(overlays.rateLimit?.message, '全局过频');

    const noRl = resolveWwwMountOverlays({ staticRoot: '.' }, server);
    assert.equal(noRl.rateLimit, null);
    assert.equal(noRl.static.cacheTime, '1d');

    assert.deepEqual(mergePreferDefined({ a: 1, b: 2 }, { b: 9, c: 3 }), { a: 1, b: 9, c: 3 });
    const opts = applyWwwStaticOverlay(
      { maxAge: '1d', index: ['index.html'], immutable: true },
      overlays.static,
    );
    assert.equal(opts.maxAge, '1h');
  });

  it('sign 损坏时回退零配置静态', () => {
    const dir = tmpApp();
    fs.writeFileSync(path.join(dir, 'sign.json'), '{not-json');
    const read = readWwwSignFile(path.join(dir, 'sign.json'));
    assert.equal(read.ok, false);
    assert.equal(isActiveFrontendSign(path.join(dir, 'sign.json')), false);
    const d = resolveWwwAppMount(dir);
    assert.equal(d.kind, 'plain');
    assert.equal(d.mode, 'static');
    assert.equal(d.staticRoot, dir);
    assert.match(String(d.reason), /零配置静态|sign 无效/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('enabled:false + dist → 静态挂 dist', () => {
    const dir = tmpApp();
    writeSign(dir, { enabled: false, id: 't' });
    const dist = path.join(dir, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
    const d = resolveWwwAppMount(dir);
    assert.equal(d.kind, 'signed');
    assert.equal(d.mode, 'static');
    assert.equal(d.staticRoot, dist);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serve:static 即使 enabled true 也静态', () => {
    const dir = tmpApp();
    writeSign(dir, { enabled: true, serve: 'static', id: 't' });
    const dist = path.join(dir, 'dist');
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
    const d = resolveWwwAppMount(dir);
    assert.equal(d.kind, 'signed');
    assert.equal(d.mode, 'static');
    assert.equal(d.staticRoot, dist);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('enabled true 默认 proxy', () => {
    const dir = tmpApp();
    writeSign(dir, { enabled: true, id: 't', command: 'pnpm', port: 1 });
    const d = resolveWwwAppMount(dir);
    assert.equal(d.kind, 'signed');
    assert.equal(d.mode, 'proxy');
    assert.equal(d.staticRoot, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('staticRoot 自定义且防目录穿越', () => {
    const dir = tmpApp();
    const custom = path.join(dir, 'release');
    fs.mkdirSync(custom);
    fs.writeFileSync(path.join(custom, 'index.html'), '<html></html>');
    assert.equal(resolveWwwStaticRoot(dir, { staticRoot: 'release' }).root, custom);

    const r = resolveWwwStaticRoot(dir, { staticRoot: '../outside' });
    assert.equal(r.root, dir);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('前端工程无 dist 的 Vite 源码树给出 warn', () => {
    const dir = tmpApp();
    writeSign(dir, { enabled: false, serve: 'static', id: 't' });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(dir, 'vite.config.js'), 'export default {}');
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<script type="module" src="/src/main.js"></script>'
    );
    const r = resolveWwwStaticRoot(dir, { enabled: false, serve: 'static' });
    assert.equal(r.root, dir);
    assert.ok(r.warn && /dist/i.test(r.warn));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('启动过程 stale：无产物需 build；产物新于源码则跳过', async () => {
    const {
      resolveSignedStaticBuildSpec,
      isSignedStaticBuildStale,
    } = await import('../../dist/src/infrastructure/http/www-static-build.js');
    const sign = { enabled: false, build: { command: 'pnpm', args: ['build'] }, staticRoot: 'dist' };
    assert.equal(resolveSignedStaticBuildSpec(sign, process.cwd())?.command, 'pnpm');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrk-www-stale-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t"}');
      fs.writeFileSync(path.join(dir, 'sign.json'), '{}');
      const noDist = { via: '.', root: dir, warn: 'missing' };
      assert.equal(isSignedStaticBuildStale(dir, sign, noDist), true);

      const dist = path.join(dir, 'dist');
      fs.mkdirSync(dist);
      fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>');
      const future = Date.now() + 60_000;
      fs.utimesSync(path.join(dist, 'index.html'), future / 1000, future / 1000);
      const withDist = { via: 'dist', root: dist };
      assert.equal(isSignedStaticBuildStale(dir, sign, withDist), false);

      const later = future + 120_000;
      fs.utimesSync(path.join(dir, 'package.json'), later / 1000, later / 1000);
      assert.equal(isSignedStaticBuildStale(dir, sign, withDist), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
