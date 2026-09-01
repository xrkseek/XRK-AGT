/**
 * 统一测试入口（package.json 各 test:* 脚本只调此文件）
 *
 * 用法: node tests/run.mjs <suite>
 *   fast         — 无 Bootstrap、无真实 HTTP 起服（默认 CI 快路径）
 *   smoke        — fast 子集 + 质量金字塔轻量门禁（冒烟/浸泡/混沌雏形）
 *   unit         — 除 e2e 外全部单元/集成测
 *   integration  — 仅 Loader 集成
 *   e2e          — 真实启动 AgentRuntime
 *   all          — framework 下全部 *.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frameworkDir = path.join(root, 'tests/framework');

/** @type {Record<string, string[]>} */
const SUITES = {
  fast: [
    'auth-loopback.test.mjs',
    'config-alignment.test.mjs',
    'module-inventory.test.mjs',
    'module-import-error.test.mjs',
    'onebot-atbot.test.mjs',
    'agent-layout.test.mjs',
    'harness-module-loop.test.mjs',
    'module-ext.test.mjs',
    'agt-loop-cleanup.test.mjs',
    'safe-os-network.test.mjs',
    'monitor-safety.test.mjs',
    'observability.test.mjs',
    'input-validator.test.mjs',
    'input-path-fuzz.test.mjs',
    'vision-fuzz.test.mjs',
    'vision-content.test.mjs',
    'chat-user-visible-ack.test.mjs',
    'token-estimate.test.mjs',
    'metrics-stats.test.mjs',
    'http-request-metrics.test.mjs',
    'persistence-registry.test.mjs',
    'sqlite-runtime.test.mjs',
    'levenshtein.test.mjs',
    'load-stress-light.test.mjs',
    'quality-pyramid-light.test.mjs',
    'perf-engine.test.mjs',
    'disposables-concurrency.test.mjs',
    'stream-request-context.test.mjs',
    'runtime-polish.test.mjs',
    'runtime-net.test.mjs',
    'www-xrk.test.mjs',
    'www-web-compat.test.mjs',
    'mount-core-www.test.mjs',
    'http-api-structure.test.mjs',
    'http-init-hook.test.mjs',
    'bootstrap-deps.test.mjs',
    'renderer-lazy.test.mjs',
    'process-signals.test.mjs',
  ],
  smoke: [
    'quality-pyramid-light.test.mjs',
    'load-stress-light.test.mjs',
    'vision-content.test.mjs',
    'input-path-fuzz.test.mjs',
    'observability.test.mjs',
    'auth-loopback.test.mjs',
  ],
  integration: ['loaders-integration.test.mjs'],
  e2e: ['server-e2e.test.mjs'],
};

function unitTests() {
  const e2e = new Set(SUITES.e2e);
  return fs
    .readdirSync(frameworkDir)
    .filter((f) => f.endsWith('.test.mjs') && !e2e.has(f))
    .sort();
}

function resolveFiles(mode) {
  if (mode === 'all') {
    return fs.readdirSync(frameworkDir).filter((f) => f.endsWith('.test.mjs')).sort();
  }
  if (mode === 'unit') return unitTests();
  const list = SUITES[mode];
  if (!list) return null;
  return list;
}

const mode = process.argv[2] || 'unit';
const files = resolveFiles(mode);
if (!files?.length) {
  console.error(`未知 suite: ${mode}；可用: fast | smoke | unit | integration | e2e | all`);
  process.exit(2);
}

const missing = files.filter((f) => !fs.existsSync(path.join(frameworkDir, f)));
if (missing.length) {
  console.error(`缺少测试文件: ${missing.join(', ')}`);
  process.exit(2);
}

const testArgs = [
  '--experimental-strip-types',
  '--test',
  '--test-force-exit',
  ...files.map((f) => path.join('tests/framework', f)),
];

const result = spawnSync(process.execPath, testArgs, { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
