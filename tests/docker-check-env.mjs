#!/usr/bin/env node
/** Docker 本机前置 + 静态烟测（entrypoint × Node26）；有 daemon 时再提示可跑 docker:build */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function docker(args) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    windowsHide: true
  });
}

console.log('=== Docker 环境检查 ===\n');

const ver = docker(['version', '--format', '{{.Server.Version}}']);
if (ver.error?.code === 'ENOENT') {
  console.log('✗ docker   (未安装或不在 PATH)');
  console.log('  → 安装 Docker Desktop 后重开终端，再 pnpm docker:build');
} else if (ver.status !== 0) {
  console.log('✗ docker   已安装但 daemon 未就绪');
  console.log(`  ${(ver.stderr || ver.stdout || '').trim().split('\n')[0] || '(docker info 失败)'}`);
  console.log('  → 启动 Docker Desktop 后再 pnpm docker:build');
} else {
  const line = (ver.stdout || '').trim() || 'ok';
  console.log(`✓ docker   Server ${line}`);
  console.log('  → 可跑: pnpm docker:build');
  console.log('  → 可选: pnpm docker:build:browser（runtime-browser + Playwright）');
}

console.log('\n=== 静态烟测 (entrypoint × Node26) ===\n');
const testFile = path.join(root, 'tests/framework/docker-entrypoint-node26.test.mjs');
const t = spawnSync(process.execPath, ['--test', testFile], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
process.exitCode = t.status === 0 ? 0 : t.status ?? 1;
