#!/usr/bin/env node
/** Docker 全栈：clean · build · up · fresh · status */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subserverHealthEndpoints } from '#utils/subserver-runtimes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = path.join(root, 'config', 'docker.env');
const compose = path.join(root, 'docker-compose.yml');

function docker(args, { soft = false, timeout, env, stdio = 'inherit' } = {}) {
  const r = spawnSync('docker', args, {
    cwd: root,
    stdio,
    encoding: stdio === 'pipe' ? 'utf8' : undefined,
    env: env ? { ...process.env, ...env } : process.env,
    timeout
  });
  if (!soft) {
    if (r.error?.code === 'ETIMEDOUT') {
      console.error('>>> 超时');
      process.exit(1);
    }
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  return r;
}

function ensureDocker() {
  const r = docker(['info'], { soft: true, stdio: 'pipe' });
  if (r.status === 0) return;
  if (r.error?.code === 'ENOENT') {
    console.error('>>> Docker 未安装或不在 PATH（请安装 Docker Desktop）');
  } else {
    console.error('>>> Docker 未运行（请启动 Docker Desktop）');
  }
  process.exit(1);
}

function composeArgs() {
  const a = ['compose', '-f', compose];
  if (fs.existsSync(envFile)) a.push('--env-file', envFile);
  return a;
}

function compactVhdxWin() {
  if (process.platform !== 'win32') return;
  const vhdx = path.join(process.env.LOCALAPPDATA || '', 'Docker', 'wsl', 'disk', 'docker_data.vhdx');
  if (!fs.existsSync(vhdx)) return;
  const before = fs.statSync(vhdx).size;
  console.log(`>>> 压缩 docker_data.vhdx（${(before / 1024 ** 3).toFixed(1)} GB）`);
  docker(['desktop', 'stop'], { soft: true });
  spawnSync('wsl', ['--shutdown'], { shell: true, stdio: 'inherit' });
  const script = path.join(process.env.TEMP || '', 'xrk-compact-docker.txt');
  try {
    fs.writeFileSync(script, [
      `select vdisk file="${vhdx}"`, 'attach vdisk readonly', 'compact vdisk', 'detach vdisk', 'exit'
    ].join('\r\n'));
    spawnSync('diskpart', ['/s', script], { shell: true, stdio: 'inherit' });
  } finally {
    fs.rmSync(script, { force: true });
  }
  const after = fs.statSync(vhdx).size;
  console.log(`>>> ${(before / 1024 ** 3).toFixed(1)} → ${(after / 1024 ** 3).toFixed(1)} GB（释放 ${((before - after) / 1024 ** 3).toFixed(1)} GB）`);
  docker(['desktop', 'start'], { soft: true });
}

function clean({ compact = false } = {}) {
  ensureDocker();
  docker([...composeArgs(), 'down', '--rmi', 'all', '--remove-orphans', '-v'], { soft: true });
  docker(['system', 'prune', '-af', '--volumes'], { soft: true });
  docker(['builder', 'prune', '-af'], { soft: true });
  if (compact) compactVhdxWin();
  console.log('>>> clean 完成');
}

function build({ pull = false, services = [], browser = false } = {}) {
  ensureDocker();
  const args = [...composeArgs(), 'build'];
  if (pull) args.push('--pull');
  if (services.length) args.push(...services);
  console.log(`>>> build${services.length ? ` ${services.join(' ')}` : ' 全栈'}${browser ? ' +browser' : ''}`);
  docker(args, {
    timeout: 90 * 60 * 1000,
    env: {
      COMPOSE_PARALLEL_LIMIT: '2',
      XRK_DOCKER_TARGET: browser ? 'runtime-browser' : 'runtime',
      XRK_DOCKER_TAG: browser ? 'browser' : 'latest'
    }
  });
}

function up() {
  ensureDocker();
  docker([...composeArgs(), 'up', '-d', '--wait'], { timeout: 15 * 60 * 1000 });
}

function down() {
  ensureDocker();
  docker([...composeArgs(), 'down']);
}

async function status() {
  ensureDocker();
  docker([...composeArgs(), 'ps'], { soft: true });
  console.log('\n>>> 健康探测');
  for (const [name, url] of subserverHealthEndpoints()) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      console.log(`  ${name.padEnd(4)} ${res.ok ? 'OK' : `HTTP ${res.status}`}  ${url}`);
    } catch (e) {
      console.log(`  ${name.padEnd(4)} FAIL  ${url}`);
    }
  }
}

const mode = process.argv[2] || 'help';
const rest = process.argv.slice(3);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const services = rest.filter((a) => !a.startsWith('--'));
switch (mode) {
  case 'clean':
    clean({ compact: flags.has('--compact') });
    break;
  case 'build':
    build({ pull: flags.has('--pull'), browser: flags.has('--browser'), services });
    break;
  case 'up':
    up();
    break;
  case 'down':
    down();
    break;
  case 'status':
    await status();
    break;
  case 'fresh':
    clean();
    build({ pull: true });
    up();
    console.log('\n>>> 全栈已启动 · http://127.0.0.1:8080');
    break;
  default:
    console.log(`用法: node src/utils/docker-stack.mjs <命令>

  clean    down + prune（--compact 压缩 C 盘 vhdx）
  build    构建（--browser / --pull / 服务名）
  up       启动并等待 healthcheck
  down     停止
  status   ps + 健康探测
  fresh    clean + build --pull + up`);
    process.exit(mode === 'help' ? 0 : 1);
}
