#!/usr/bin/env node
/**
 * lint 门禁：eslint 必须零问题，且必须真的在扫源码。
 *
 * 为什么不能直接用 `pnpm lint`：
 *   eslint 的 ignores 是「排除」语义——一旦某条规则写得过宽（比如一条能划掉
 *   全部目录的顶层通配规则），eslint 会安静地什么都不扫并返回 0，形成永远绿
 *   的门禁。本仓库已经吃过两次同类亏：glob 工具对 tests/checks/*.mjs 静默返回
 *   零匹配；PowerShell 的 @(git ls-files -z) 把行数统计成 1。所以「门禁在跑」
 *   本身必须可验证，不能靠人看退出码。
 *
 * 判据：
 *   1. errorCount + warningCount == 0
 *   2. 实际 lint 的文件数 >= MIN_FILES（证明范围没被扫空）
 *
 * 阈值 50：当前实测 128 个文件，留一半余量给后续删文件。
 * `--min=N` 可临时改阈值；用 `--min=999` 跑一次会失败，正是用来证明这条
 * 下限断言本身会触发（否则「它到底还生不生效」又变成一个不可验证的假设）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIN_FILES = (() => {
  const arg = process.argv.find((a) => a.startsWith('--min='));
  const n = arg ? Number(arg.slice('--min='.length)) : 50;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
})();

const eslintBin = path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
if (!existsSync(eslintBin)) {
  console.error(`[lint-gate] 找不到 ${eslintBin}，先执行 pnpm install`);
  process.exit(1);
}

const res = spawnSync(
  process.execPath,
  [eslintBin, '.', '-f', 'json'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

if (res.error) {
  console.error(`[lint-gate] eslint 执行失败：${res.error.message}`);
  process.exit(1);
}

// eslint 把结果写 stdout；出错信息走 stderr。两者都要看，缺一不可。
let report;
try {
  report = JSON.parse(res.stdout || '[]');
} catch {
  console.error('[lint-gate] 无法解析 eslint 的 JSON 输出，门禁无法判定，判为失败：');
  console.error((res.stdout || '').slice(0, 1000));
  console.error((res.stderr || '').slice(0, 1000));
  process.exit(1);
}

if (!Array.isArray(report)) {
  console.error('[lint-gate] eslint 输出不是数组，判为失败');
  process.exit(1);
}

// 范围健全性：门禁在扫东西吗？
if (report.length < MIN_FILES) {
  console.error(
    `[lint-gate] ❌ eslint 只扫到 ${report.length} 个文件（下限 ${MIN_FILES}）。` +
    '几乎可以断定 eslint.config.js 的 ignores 写宽了——门禁会变成永远绿。',
  );
  process.exit(1);
}

const problems = report
  .filter((f) => f.errorCount + f.warningCount > 0)
  .map((f) => {
    const rel = f.filePath.replace(/\\/g, '/').split('/XRK-AGT/').pop();
    const detail = f.messages
      .map((m) => `    ${m.line}:${m.column} ${m.ruleId} ${m.message}`)
      .join('\n');
    return `  ${rel} (${f.errorCount}E/${f.warningCount}W)\n${detail}`;
  });

if (problems.length > 0) {
  const total = report.reduce((n, f) => n + f.errorCount + f.warningCount, 0);
  console.error(`[lint-gate] ❌ eslint 报出 ${total} 个问题（已扫 ${report.length} 个文件）：\n`);
  for (const p of problems) console.error(`${p}\n`);
  process.exit(1);
}

console.log(`[lint-gate] ✅ eslint 零问题（已扫 ${report.length} 个文件，下限 ${MIN_FILES}）`);
