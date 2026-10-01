/**
 * 覆盖率门禁（node:test 内置覆盖率采集，零新增依赖）。
 *
 * 用法: node tests/coverage-gate.mjs   （或 node tests/run.mjs coverage）
 *
 * 设计：
 * - 跑 unit + integration 两 lane（与 run.mjs fast 同源）并开启覆盖率采集。
 * - 只对 GATE 里的纯逻辑模块设阈值，不对全仓设阈值（大量 UI/胶水代码会稀释成
 *   无意义数字），与 harness 把 kernel 单独拆 lane 的理由同构。
 * - GATE 键写 dist 下的相对路径（可读性/可校验），实际匹配报告时按 basename
 *   —— node 的覆盖率报告是树形缩进，目录独占行，完整相对路径并不出现。
 *   唯一性由 GATE 键自身保证（不同 dist 目录不得有同名 basename）。
 *
 * 阈值 = 现状实测值 − 3~5pp，作为「锁防回退」位；补强后可继续上调。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { COVERAGE_LANES, ROOT, TESTS_DIR, testsFor } from './lanes.mjs';

const root = ROOT;
const testsDir = TESTS_DIR;

/** @type {Record<string, number>} 键 = dist 下相对路径，值 = 行覆盖阈值（% Lines） */
const GATE = {
  'src/infrastructure/config/config-constants.js': 95, // 现状 100（type-guard 补全后）
  'src/utils/exec-async.js': 95, // 现状 100
  'src/utils/loader-constants.js': 95, // 现状 100
  'src/utils/metrics-stats.js': 90, // 现状 95.93
  'src/utils/token-estimate.js': 90, // 现状 97.4
  'src/utils/path-guards.js': 72, // 现状 77.78（POSIX 分支为本平台上限）
  'src/utils/input-validator.js': 95, // 现状 98.86（补 7 方法后）
  'src/utils/prng.js': 95, // 现状 100
  'src/utils/llm/llm-http-error.js': 95, // 现状 100（Retry-After 三形态 + 钳制边界）
  'src/utils/llm/tool-name-utils.js': 95, // 现状 100（规范化↔还原往返）
  'src/utils/media-ref.js': 95, // 现状 100（五类魔数 + 路径判定）
  'src/infrastructure/crawl/cache-utils.js': 95, // 现状 100（TTL + FIFO 淘汰）
  'src/infrastructure/http/utils/botInventory.js': 95, // 现状 100（三级排序 + 拉取降级）
};

/** 覆盖率采集范围：unit + integration（与 run.mjs fast 同源，实现在 tests/lanes.mjs） */
const files = testsFor(COVERAGE_LANES);
console.log(`[coverage-gate] 跑 ${files.length} 个 fast 测试（unit+integration，内置覆盖率采集）…`);

const result = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--test',
    '--test-force-exit',
    '--experimental-test-coverage',
    ...files.map((f) => path.join(testsDir, f)),
  ],
  { cwd: root, encoding: 'utf8' },
);

// 【必须先判测试结果，再判覆盖率】
// 覆盖率报告与用例结果在同一份输出里；若测试挂掉，覆盖率数字会偏低甚至缺失。
// 缺这一句的话，「测试红」会伪装成「覆盖率不达标」，把真失败藏进门禁细节里。
const testStatus = result.status;
if (testStatus !== 0) {
  // 原始输出已随 stdio 之外捕获在 result 中，向上抛前补印关键行，避免静默
  const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .filter((l) => /^ℹ (tests|pass|fail|skipped) /.test(l) || l.includes('not ok'))
    .slice(0, 20);
  console.error('[coverage-gate] ❌ 测试本身未全绿，先修测试再谈覆盖率：');
  for (const l of tail) console.error(`  ${l.trim()}`);
}

const report = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

/**
 * 解析内置报告行。node 报告形如：
 *   ℹ     config-constants.js      |  86.44 |  100.00 |  20.00 | 42-43 ...
 * 目录层级独占行且无百分比，故只匹配「含 basename 且带两列百分比」的行。
 * @param {string} basename
 */
function linePct(basename) {
  const line = report
    .split(/\r?\n/)
    .find(
      (l) =>
        l.includes(basename) &&
        new RegExp(`${basename.replace(/\./g, '\\.')}\\s*\\|\\s*\\d+\\.\\d+\\s*\\|\\s*\\d+\\.\\d+\\s*\\|`).test(l),
    );
  if (!line) return null;
  const m = line.match(/\|\s*(\d+\.\d+)\s*\|\s*\d+\.\d+\s*\|/);
  return m ? Number(m[1]) : null;
}

let fail = testStatus !== 0;
for (const [rel, threshold] of Object.entries(GATE)) {
  const pct = linePct(path.basename(rel));
  if (pct === null) {
    console.error(`[coverage-gate] 未在报告中找到 ${rel}（未加载或路径不对？）`);
    fail = true;
    continue;
  }
  const ok = pct >= threshold;
  if (!ok) fail = true;
  console.log(
    `[coverage-gate] ${rel}: ${pct}% (阈 ${threshold}%) ${ok ? '✅' : '❌ 未达标'}`,
  );
}

console.log('');
if (fail) {
  console.error('[coverage-gate] 未通过：请补用例或确认阈值合理（见 tests/coverage-gate.mjs GATE）');
  process.exit(1);
}
console.log('[coverage-gate] ✅ 全部达标');
