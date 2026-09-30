/**
 * xrk-node-runtime 门禁：扫 src/ 旧写法（判错 / base64·hex / AbortController+setTimeout abort / promisify(exec)）。
 * 允许：`src/utils/exec-async.ts` 内唯一的 promisify(exec)。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(root, 'src');
const ALLOW_PROMISIFY = path.join(SRC, 'utils', 'exec-async.ts');

function walkTs(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTs(full, out);
    else if (/\.(ts|mjs|cjs|js)$/.test(ent.name) && !ent.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(root, p).replace(/\\/g, '/');
}

describe('node-26 runtime gate (src)', () => {
  it('no instanceof Error for error checks', () => {
    const hits = [];
    for (const file of walkTs(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/\berr(?:or)?\s+instanceof\s+Error\b|\binstanceof\s+Error\b/.test(text)) {
        // 展示类型名注释可放行；本仓统一 Error.isError
        hits.push(rel(file));
      }
    }
    assert.deepEqual(hits, [], hits.join('\n'));
  });

  it('no toString(base64|hex) / Buffer.from(s, base64)', () => {
    const hits = [];
    for (const file of walkTs(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (
        /\.toString\(\s*['"]base64['"]\s*\)/.test(text)
        || /\.toString\(\s*['"]hex['"]\s*\)/.test(text)
        || /Buffer\.from\([^,]+,\s*['"]base64['"]\s*\)/.test(text)
      ) {
        hits.push(rel(file));
      }
    }
    assert.deepEqual(hits, [], hits.join('\n'));
  });

  it('no AbortController + setTimeout(abort) pattern', () => {
    const hits = [];
    for (const file of walkTs(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (
        /new\s+AbortController\s*\(/.test(text)
        && /setTimeout\s*\(\s*\(\s*\)\s*=>\s*\w+\.abort\s*\(/.test(text)
      ) {
        hits.push(rel(file));
      }
    }
    assert.deepEqual(hits, [], hits.join('\n'));
  });

  it('promisify(exec) only in exec-async.ts', () => {
    const hits = [];
    for (const file of walkTs(SRC)) {
      if (path.resolve(file) === path.resolve(ALLOW_PROMISIFY)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/promisify\s*\(\s*exec\b/.test(text) || /from\s+['"]node:child_process\/promises['"]/.test(text)) {
        hits.push(rel(file));
      }
    }
    assert.deepEqual(hits, [], hits.join('\n'));
  });
});
