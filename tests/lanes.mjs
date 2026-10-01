/**
 * lane 目录单一事实源：run.mjs（挑测试）与 coverage-gate.mjs（挑采集范围）共用。
 *
 * 【为什么抽出来】
 * 两处各写一份「遍历 unit+integration 下的 *.test.mjs」时，任何一侧漂移都会
 * 造成「门禁看的模块集 ≠ 实际跑的测试集」，且漂移不会报错、只会静默失守。
 * lane 增删/改名只改本文件。
 *
 * 【lane 语义】按运行性质分层，而非被测对象：
 *   - unit/        毫秒级纯逻辑，进程内直调
 *   - integration/ 进程内 mock/组装，无需真实端口/Redis/起服
 *   - e2e/         真起 AgentRuntime / 全量 Loader 扫描，秒级
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** tests/ 绝对路径 */
export const TESTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
/** 仓库根绝对路径 */
export const ROOT = path.resolve(TESTS_DIR, '..');

/** 全部 lane，顺序即 all 的拼接顺序（快的在前，便于早失败） */
export const LANES = ['unit', 'integration', 'e2e'];

/** 覆盖率采集范围：e2e 不参与（真起服，覆盖率数字无意义且显著拖慢门禁） */
export const COVERAGE_LANES = ['unit', 'integration'];

/**
 * lane 目录下全部 *.test.mjs，路径相对 tests/，已排序。
 * 目录即事实源：新增测试放进对应 lane 即自动入，无需改任何清单。
 * @param {string} lane
 * @returns {string[]}
 */
export function laneTests(lane) {
  const dir = path.join(TESTS_DIR, lane);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join(lane, f));
}

/**
 * 多 lane 合并（去重 + 排序），路径相对 tests/。
 * @param {string[]} lanes
 * @returns {string[]}
 */
export function testsFor(lanes) {
  return [...new Set(lanes.flatMap(laneTests))].sort();
}
