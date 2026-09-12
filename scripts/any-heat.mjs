/**
 * src/ TypeScript `any` 热度榜（按文件匹配计数）。
 *
 * 用法:
 *   node scripts/any-heat.mjs              # 打印榜 + 相对基线摘要
 *   node scripts/any-heat.mjs --write-baseline
 *   node scripts/any-heat.mjs --check      # 顶层热文件未达 ≥50% 降幅则 exit 1
 *
 * 计数：词边界 `\bany\b`（含 `: any` / `as any` / `Promise<any>` 等；不含注释剥离，偏严可接受）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');
const BASELINE_PATH = path.join(root, 'tests', 'baselines', 'any-heat-baseline.json');
const ANY_RE = /\bany\b/g;
/** 顶层热文件：基线按 count 降序取前 N，验收降幅目标 */
const TOP_N = 15;
const REDUCE_TARGET = 0.5;

const args = new Set(process.argv.slice(2));
const writeBaseline = args.has('--write-baseline');
const check = args.has('--check');

function walkTs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTs(full, out);
    else if (ent.isFile() && ent.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function countAny(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const m = text.match(ANY_RE);
  return m ? m.length : 0;
}

function scan() {
  const files = walkTs(SRC);
  const rows = [];
  let total = 0;
  for (const f of files) {
    const n = countAny(f);
    if (n <= 0) continue;
    const rel = path.relative(root, f).replace(/\\/g, '/');
    rows.push({ path: rel, count: n });
    total += n;
  }
  rows.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return {
    generatedAt: new Date().toISOString(),
    root: 'src',
    fileCount: files.length,
    hitFileCount: rows.length,
    totalAny: total,
    topN: TOP_N,
    reduceTarget: REDUCE_TARGET,
    files: rows,
  };
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function topPaths(snapshot, n = TOP_N) {
  return (snapshot.files || []).slice(0, n).map((r) => r.path);
}

function compare(current, baseline) {
  const baseMap = new Map((baseline.files || []).map((r) => [r.path, r.count]));
  const curMap = new Map((current.files || []).map((r) => [r.path, r.count]));
  const tops = topPaths(baseline, baseline.topN || TOP_N);
  const perFile = tops.map((p) => {
    const before = baseMap.get(p) ?? 0;
    const after = curMap.get(p) ?? 0;
    const drop = before === 0 ? 1 : (before - after) / before;
    return { path: p, before, after, dropRatio: drop, met: drop >= (baseline.reduceTarget ?? REDUCE_TARGET) };
  });
  const metCount = perFile.filter((x) => x.met).length;
  const totalBefore = baseline.totalAny ?? 0;
  const totalAfter = current.totalAny ?? 0;
  const totalDrop = totalBefore === 0 ? 1 : (totalBefore - totalAfter) / totalBefore;
  return {
    topN: tops.length,
    metCount,
    allTopMet: metCount === tops.length && tops.length > 0,
    totalBefore,
    totalAfter,
    totalDropRatio: totalDrop,
    perFile,
  };
}

function printTable(rows, limit = 25) {
  const slice = rows.slice(0, limit);
  const w = Math.max(8, ...slice.map((r) => r.path.length));
  console.log(`${'count'.padStart(6)}  path`);
  console.log(`${'-'.repeat(6)}  ${'-'.repeat(w)}`);
  for (const r of slice) {
    console.log(`${String(r.count).padStart(6)}  ${r.path}`);
  }
  if (rows.length > limit) console.log(`… +${rows.length - limit} more hit files`);
}

const snap = scan();
console.log(
  `[any-heat] src .ts files=${snap.fileCount} hits=${snap.hitFileCount} totalAny=${snap.totalAny}`,
);
printTable(snap.files);

if (writeBaseline) {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  const out = {
    ...snap,
    note: `Baseline for ≥${REDUCE_TARGET * 100}% any drop on top ${TOP_N} files + typecheck green`,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`[any-heat] wrote baseline → ${path.relative(root, BASELINE_PATH).replace(/\\/g, '/')}`);
}

const baseline = loadBaseline();
if (baseline && !writeBaseline) {
  const cmp = compare(snap, baseline);
  console.log(
    `[any-heat] vs baseline ${baseline.generatedAt}: total ${cmp.totalBefore} → ${cmp.totalAfter}`
      + ` (drop ${(cmp.totalDropRatio * 100).toFixed(1)}%);`
      + ` top${cmp.topN} met ${cmp.metCount}/${cmp.topN} (≥${(REDUCE_TARGET * 100).toFixed(0)}% each)`,
  );
  for (const row of cmp.perFile) {
    const pct = (row.dropRatio * 100).toFixed(1);
    const tag = row.met ? '已降' : '未降';
    console.log(
      `  [${tag}] ${String(row.before).padStart(4)}→${String(row.after).padStart(4)} (${pct}%)  ${row.path}`,
    );
  }
  const unmet = cmp.perFile.filter((x) => !x.met);
  if (unmet.length) {
    console.log(`[any-heat] 次日债（未达 ≥${(REDUCE_TARGET * 100).toFixed(0)}% 降幅）:`);
    unmet
      .slice()
      .sort((a, b) => b.after - a.after || a.dropRatio - b.dropRatio)
      .forEach((row, i) => {
        const prio = row.after >= 100 ? 'P0' : row.after >= 50 ? 'P1' : 'P2';
        console.log(
          `  ${prio}  ${row.path}  ${row.before}→${row.after}  (${(row.dropRatio * 100).toFixed(1)}%)`,
        );
        if (i === 0 && prio === 'P0') {
          /* keep list order by after count */
        }
      });
  }
  if (check && !cmp.allTopMet) {
    console.error(
      `[any-heat] CHECK FAIL: need ≥${REDUCE_TARGET * 100}% drop on each of baseline top ${cmp.topN} (met ${cmp.metCount}/${cmp.topN})`,
    );
    process.exit(1);
  }
  if (check && cmp.allTopMet) {
    console.log('[any-heat] CHECK PASS: top hot files met reduce target');
  }
} else if (check && !baseline) {
  console.error(`[any-heat] CHECK FAIL: missing baseline at ${BASELINE_PATH}`);
  process.exit(1);
}
