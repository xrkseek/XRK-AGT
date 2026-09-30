/**
 * 统一测试入口（package.json 各 test:* 脚本只调此文件）
 *
 * 用法: node tests/run.mjs <suite>
 *   fast         — unit + integration（无真实起服，默认 CI 快路径）
 *   smoke        — fast 子集 + 质量金字塔轻量门禁
 *   unit         — 纯逻辑单元（不含 integration）
 *   integration  — 进程内集成/mock 链路（含 harness 契约直测）
 *   e2e          — 真实启动 AgentRuntime / 全量 Loader 集成
 *   all          — 三 lane 全部 *.test.mjs
 *   coverage     — unit + integration + 覆盖率门禁（Node 内置 c8，无新增依赖）
 *
 * 【为什么 lane 用目录而非清单】
 * 历史上 fast 是一份 55 条手工清单、smoke/e2e 各有名单，新增测试默认落不进
 * 默认路径，形成「单文件本地绿、CI 从不跑」的隐性盲区。harness 侧的做法是
 * include glob（新增即入 lane），此处同构：suite → 目录，目录即事实源。
 * 按「运行性质」分层（而非被测对象）：
 *   - unit/       毫秒级纯逻辑，进程内直调 dist 编译产物
 *   - integration/进程内 mock/组装，无需真实端口/Redis/起服
 *   - e2e/        真起 AgentRuntime / 全量 Loader 扫描，秒级
 * 新测试按性质放进对应目录即自动入 lane，无需改本文件。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(root, 'tests');

const LANES = {
  unit: ['unit'],
  integration: ['integration'],
  e2e: ['e2e'],
};

/**
 * 显式套件（跨 lane 精选子集；路径相对 tests/，含 lane 目录）。
 * 与 lane 推导不同：smoke 是「质量金字塔轻量门禁」的固定精选，新增测试不自动入。
 */
const SUITES = {
  smoke: [
    'unit/quality-pyramid-light.test.mjs',
    'unit/load-stress-light.test.mjs',
    'unit/vision-content.test.mjs',
    'unit/input-path-fuzz.test.mjs',
    'unit/observability.test.mjs',
    'integration/auth-loopback.test.mjs',
  ],
};

/** lane 目录下全部 *.test.mjs（唯一事实源，新增即入） */
function laneTests(lane) {
  const dir = path.join(testsDir, lane);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join(lane, f));
}

/** fast：unit + integration（新增测试自动入内） */
function fastTests() {
  return [...laneTests('unit'), ...laneTests('integration')];
}

/** all：三 lane 全量 */
function allTests() {
  return [...laneTests('unit'), ...laneTests('integration'), ...laneTests('e2e')];
}

function resolveFiles(mode) {
  if (mode === 'all') return allTests();
  if (mode === 'fast') return fastTests();
  if (mode === 'unit') return laneTests('unit');
  if (mode === 'integration') return laneTests('integration');
  if (mode === 'e2e') return laneTests('e2e');
  const list = SUITES[mode];
  if (!list) return null;
  return list.slice();
}

/**
 * 自校验：显式套件引用的文件必须真实存在。
 * lane 推导由目录保证，不会出现「清单写了但文件没了」。
 * @param {string[]} files
 */
function assertFilesExist(files) {
  const missing = files.filter((f) => !fs.existsSync(path.join(testsDir, f)));
  if (missing.length) {
    console.error(`缺少测试文件: ${missing.join(', ')}`);
    process.exit(2);
  }
}

const mode = process.argv[2] || 'unit';
if (mode === 'coverage') {
  // 覆盖率门禁是独立真源（tests/coverage-gate.mjs），这里只转发
  const gate = spawnSync(
    process.execPath,
    [path.join('tests', 'coverage-gate.mjs')],
    { cwd: root, stdio: 'inherit' },
  );
  process.exit(gate.status ?? 1);
}
const files = resolveFiles(mode);
if (!files?.length) {
  console.error(
    `未知 suite: ${mode}；可用: fast | smoke | unit | integration | e2e | all | coverage`,
  );
  process.exit(2);
}

assertFilesExist(files);

/** 覆盖度日志：新增测试漏跑时能一眼看出（仅 lane 模式，smoke 是精选子集不算覆盖） */
if (['fast', 'all', 'unit', 'integration', 'e2e'].includes(mode)) {
  const total = allTests().length;
  const skipped = total - files.length;
  console.log(`[tests] suite=${mode} 选中 ${files.length}/${total} 个（未选 ${skipped}）`);
  if (skipped > 0) {
    console.log(`[tests] 未选: ${allTests().filter((f) => !files.includes(f)).join(', ')}`);
  }
}

/** `#` imports 指向 dist；无产物时先构建 */
const distMarker = path.join(root, 'dist', 'src', 'utils', 'paths.js');
if (!fs.existsSync(distMarker)) {
  console.log('[tests] dist 缺失，运行 pnpm build…');
  const build = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', shell: true });
  if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1);
}

const testArgs = [
  '--experimental-strip-types',
  '--test',
  '--test-force-exit',
  ...files.map((f) => path.join('tests', f)),
];

const result = spawnSync(process.execPath, testArgs, { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
