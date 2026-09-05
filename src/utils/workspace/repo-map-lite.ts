// @ts-nocheck
import fs from 'fs/promises';
import path from 'path';
import { estimateTokensMixed } from '#utils/token-estimate.js';

/**
 * 工作区地图（aider RepoMap 可移植核心，无 tree-sitter / networkx）。
 * 供 `tools.repo_map`：扩展名扫描 + 符号正则 + import 图 + 迭代 PageRank + query 个性化。
 * 输出为截断后的纯文本地图，便于塞进 tool 结果；非完整 AST。
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.venv', 'venv', 'target', 'vendor', '.xrk', 'data'
]);

const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs',
  '.java', '.kt', '.md', '.json', '.yaml', '.yml', '.vue', '.svelte'
]);

const SYM_RE =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|def|fn|struct|interface|type)\s+([A-Za-z_][\w]*)/g;

/** ESM / CJS / Python 相对导入 */
const IMPORT_RES = [
  /\bfrom\s+['"](\.[^'"]+)['"]/g,
  /\bimport\s+['"](\.[^'"]+)['"]/g,
  /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  /^\s*from\s+(\.[\w./]+)\s+import\b/gm,
  /^\s*import\s+(\.[\w./]+)\s*$/gm
];

/**
 * @param {string} root
 * @param {{ maxFiles?: number, maxDepth?: number }} [opts]
 */
async function walkFiles(root, opts = {}) {
  const maxFiles = opts.maxFiles ?? 400;
  const maxDepth = opts.maxDepth ?? 4;
  const out = [];

  async function walk(dir, depth) {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) break;
      const name = ent.name;
      if (name.startsWith('.') && name !== '.env.example') continue;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(path.join(dir, name), depth + 1);
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      if (!CODE_EXT.has(ext)) continue;
      out.push(path.join(dir, name));
    }
  }

  await walk(root, 0);
  return out;
}

/**
 * @param {string} fromAbs
 * @param {string} spec
 * @param {Set<string>} absSet
 * @param {string} root
 */
function resolveImportTarget(fromAbs, spec, absSet, root) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  const candidates = [
    base,
    `${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`,
    `${base}.mjs`, `${base}.cjs`, `${base}.py`,
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
    path.join(base, '__init__.py')
  ];
  for (const c of candidates) {
    if (absSet.has(c)) return c;
  }
  // 宽松：同 basename
  const want = path.basename(spec).replace(/\.(js|ts|tsx|jsx|mjs|cjs|py)$/i, '');
  if (want.length >= 2) {
    for (const abs of absSet) {
      const b = path.basename(abs, path.extname(abs));
      if (b === want && path.dirname(abs) === path.dirname(base)) return abs;
    }
  }
  void root;
  return null;
}

/**
 * 简易 PageRank（阻尼 0.85，迭代 20）。
 * @param {Map<string, Set<string>>} edges from -> to
 * @param {string[]} nodes
 * @param {Map<string, number>} [personalization]
 */
function pageRank(edges, nodes, personalization = new Map()) {
  const n = nodes.length;
  if (!n) return new Map();
  const damp = 0.85;
  const idx = new Map(nodes.map((id, i) => [id, i]));
  let rank = new Float64Array(n).fill(1 / n);
  const pers = new Float64Array(n);
  let persSum = 0;
  for (let i = 0; i < n; i++) {
    const p = personalization.get(nodes[i]) || 0;
    pers[i] = p;
    persSum += p;
  }
  if (persSum <= 0) {
    pers.fill(1 / n);
  } else {
    for (let i = 0; i < n; i++) pers[i] /= persSum;
  }

  const outDeg = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    outDeg[i] = edges.get(nodes[i])?.size || 0;
  }

  for (let iter = 0; iter < 20; iter++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) next[i] = (1 - damp) * pers[i];
    for (let i = 0; i < n; i++) {
      const from = nodes[i];
      const outs = edges.get(from);
      if (!outs || !outs.size) {
        // 悬空节点：均匀（带个性化）
        const share = damp * rank[i] / n;
        for (let j = 0; j < n; j++) next[j] += share;
        continue;
      }
      const share = damp * rank[i] / outs.size;
      for (const to of outs) {
        const j = idx.get(to);
        if (j != null) next[j] += share;
      }
    }
    rank = next;
  }

  const out = new Map();
  for (let i = 0; i < n; i++) out.set(nodes[i], rank[i]);
  return out;
}

/**
 * @param {string} workspace
 * @param {{ query?: string, focusPaths?: string[], maxTokens?: number, maxFiles?: number }} [opts]
 * @returns {Promise<{ text: string, files: Array<{ path: string, score: number, symbols: string[], rank?: number }> }>}
 */
export async function buildRepoMapLite(workspace, opts = {}) {
  const root = path.resolve(workspace || process.cwd());
  const maxTokens = opts.maxTokens ?? 1200;
  const queryTerms = String(opts.query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2);
  const focus = new Set(
    (opts.focusPaths || []).map((p) => path.resolve(String(p)))
  );

  const files = await walkFiles(root, { maxFiles: opts.maxFiles ?? 400 });
  const absSet = new Set(files);
  /** @type {Map<string, { rel: string, symbols: string[], contentHead: string }>} */
  const meta = new Map();
  /** @type {Map<string, Set<string>>} */
  const edges = new Map();

  for (const abs of files) {
    let content = '';
    try {
      content = await fs.readFile(abs, 'utf8');
      if (content.length > 80_000) content = content.slice(0, 80_000);
    } catch {
      continue;
    }
    const symbols = [];
    SYM_RE.lastIndex = 0;
    let m;
    while ((m = SYM_RE.exec(content)) !== null) {
      if (symbols.length < 40) symbols.push(m[1]);
    }
    const rel = path.relative(root, abs).split(path.sep).join('/');
    meta.set(abs, {
      rel,
      symbols: [...new Set(symbols)].slice(0, 12),
      contentHead: content.slice(0, 4000)
    });

    const outs = edges.get(abs) || new Set();
    for (const re of IMPORT_RES) {
      re.lastIndex = 0;
      let im;
      while ((im = re.exec(content)) !== null) {
        const target = resolveImportTarget(abs, im[1], absSet, root);
        if (target && target !== abs) outs.add(target);
      }
    }
    edges.set(abs, outs);
  }

  const nodes = [...meta.keys()];
  const personalization = new Map();
  const basePers = nodes.length ? 100 / nodes.length : 1;
  for (const abs of nodes) {
    let p = 0;
    const { rel, symbols, contentHead } = meta.get(abs);
    if (focus.has(abs) || [...focus].some((f) => abs.startsWith(f + path.sep))) {
      p += basePers;
    }
    const lower = `${rel}\n${contentHead}`.toLowerCase();
    for (const t of queryTerms) {
      if (lower.includes(t)) p += basePers * 0.35;
      if (symbols.some((s) => s.toLowerCase() === t)) p += basePers * 0.5;
    }
    const base = path.basename(abs, path.extname(abs)).toLowerCase();
    if (base.length >= 3 && queryTerms.includes(base)) p += basePers * 0.4;
    if (p > 0) personalization.set(abs, p);
  }

  const ranks = pageRank(edges, nodes, personalization);
  let maxRank = 0;
  for (const r of ranks.values()) if (r > maxRank) maxRank = r;
  if (maxRank <= 0) maxRank = 1;

  const scored = [];
  for (const abs of nodes) {
    const { rel, symbols, contentHead } = meta.get(abs);
    const rank = ranks.get(abs) || 0;
    let score = (rank / maxRank) * 100;
    score += Math.min(20, symbols.length);
    if (focus.has(abs) || [...focus].some((f) => abs.startsWith(f + path.sep))) {
      score += 40;
    }
    const lower = `${rel}\n${contentHead}`.toLowerCase();
    for (const t of queryTerms) {
      if (lower.includes(t)) score += 8;
      if (symbols.some((s) => s.toLowerCase() === t)) score += 15;
    }
    scored.push({
      path: rel,
      abs,
      score,
      rank,
      symbols
    });
  }

  scored.sort((a, b) => b.score - a.score || b.rank - a.rank);

  const lines = ['# Workspace map', `root: ${root}`, 'ranking: import-graph PageRank + query personalization', ''];
  let tokens = estimateTokensMixed(lines.join('\n'));
  const picked = [];
  for (const row of scored) {
    const line = `- ${row.path}`
      + (row.symbols.length ? `  {${row.symbols.slice(0, 8).join(', ')}}` : '');
    const cost = estimateTokensMixed(line);
    if (tokens + cost > maxTokens && picked.length > 0) break;
    lines.push(line);
    tokens += cost;
    picked.push({ path: row.path, score: row.score, symbols: row.symbols, rank: row.rank });
  }

  if (!picked.length) {
    return { text: `# Workspace map\nroot: ${root}\n(empty or unscanned)`, files: [] };
  }
  return { text: lines.join('\n'), files: picked };
}
