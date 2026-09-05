#!/usr/bin/env node
/** 本机子服工具与端口检查（本地 tests/，不入库） */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SUBSERVER_RUNTIME_CATALOG } from '#utils/subserver-runtimes.js';

if (process.platform === 'win32') {
  const extra = [
    'C:\\Program Files\\Go\\bin',
    'C:\\Program Files\\PHP',
    'C:\\Program Files\\Maven\\bin',
    'C:\\Program Files\\dotnet',
    path.join(os.homedir(), '.cargo', 'bin')
  ];
  process.env.PATH = `${extra.join(';')};${process.env.PATH || ''}`;
}

const TOOLS = [
  ['node', ['-v'], '主服'],
  ['uv', ['--version'], 'pyserver'],
  ['go', ['version'], 'goserver'],
  ['php', ['-v'], 'phpserver'],
  ['java', ['-version'], 'jserver'],
  ['mvn', ['-v'], 'jserver'],
  ['dotnet', ['--version'], 'netserver'],
  ['cargo', ['--version'], 'rustserver'],
  ['docker', ['info'], 'Docker 全栈']
];

function check(cmd, args) {
  const opts = { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true };
  const r = spawnSync(cmd, args, opts);
  const line = (r.stdout || r.stderr || '').split('\n').find(Boolean) || '';
  return { ok: r.status === 0, line: line.trim().slice(0, 80) };
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

console.log('=== 子服环境检查 ===\n');
for (const [cmd, args, runtimes] of TOOLS) {
  const { ok, line } = check(cmd, args);
  console.log(`${ok ? '✓' : '✗'} ${cmd.padEnd(8)} ${ok ? line : '(未安装或不在 PATH)'}  → ${runtimes}`);
}

console.log('\n=== 端口 (127.0.0.1) ===\n');
for (const [id, meta] of Object.entries(SUBSERVER_RUNTIME_CATALOG)) {
  const free = await portFree(meta.port);
  console.log(`${free ? '空闲' : '占用'} :${meta.port}  ${id} (${meta.label})`);
}
