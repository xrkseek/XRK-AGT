/**
 * Docker 静态烟测：镜像基线 Node ≥26、entrypoint → dist/start.js、browser target。
 * 不依赖本机 Docker daemon（无 daemon 时仍应通过）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('Docker entrypoint × Node 26', () => {
  it('package.json engines.node ≥ 26', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(String(pkg.engines?.node || ''), />=\s*26/);
  });

  it('Dockerfile builder/runtime 使用 node:26-slim', () => {
    const df = read('Dockerfile');
    assert.match(df, /FROM\s+node:26-slim\s+AS\s+builder/);
    assert.match(df, /FROM\s+node:26-slim\s+AS\s+runtime/);
    assert.doesNotMatch(df, /FROM\s+node:2[0-4]/);
    assert.doesNotMatch(df, /FROM\s+node:25/);
  });

  it('ENTRYPOINT 走 docker-entrypoint.sh；server 启动 dist/start.js', () => {
    const df = read('Dockerfile');
    assert.match(df, /ENTRYPOINT\s+\[\"\/bin\/sh\",\s*\"\/app\/docker-entrypoint\.sh\"\]/);
    assert.match(df, /CMD\s+\[\"server\"\]/);

    const ep = read('docker-entrypoint.sh');
    assert.match(ep, /exec\s+node\s+--no-warnings\s+--no-deprecation\s+dist\/start\.js\s+server/);
    assert.match(ep, /\[ \"\$1\" = \"subserver\" \]/);
    assert.match(ep, /\[ \"\$1\" = \"server\" \]/);
  });

  it('可选 browser：runtime-browser + docker:build:browser', () => {
    const df = read('Dockerfile');
    assert.match(df, /FROM\s+runtime\s+AS\s+runtime-browser/);
    assert.match(df, /PLAYWRIGHT_BROWSERS_PATH/);

    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.scripts?.['docker:build:browser'], 'node src/utils/docker-stack.mjs build xrk-agt --browser');

    const stack = read('src/utils/docker-stack.mjs');
    assert.match(stack, /XRK_DOCKER_TARGET:\s*browser\s*\?\s*'runtime-browser'\s*:\s*'runtime'/);
    assert.match(stack, /from\s+'#utils\/subserver-runtimes\.js'/);

    const compose = read('docker-compose.yml');
    assert.match(compose, /target:\s*\$\{XRK_DOCKER_TARGET:-runtime\}/);
  });

  it('无 Docker 时静态烟测仍通过；有 daemon 则 info 成功', () => {
    const r = spawnSync('docker', ['info'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      windowsHide: true
    });
    if (r.error?.code === 'ENOENT' || r.status !== 0) {
      assert.ok(true, '本机无 Docker / 未启动：跳过 daemon 探测');
      return;
    }
    assert.equal(r.status, 0);
  });
});
