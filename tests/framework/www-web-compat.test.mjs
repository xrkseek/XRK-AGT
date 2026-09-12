import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  randomId,
  unwrapSuccess,
  abortTimeout,
  deepClone,
  copyText,
  downloadBlob,
} from '../../core/system-Core/www/xrk/src/utils/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compatPath = path.join(root, 'core/system-Core/www/xrk/src/utils/http.js');
const skillPath = path.join(root, '.cursor/skills/xrk-www-compat/SKILL.md');

const WWW_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.html']);
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);

function walkFiles(dir, exts, skipDirNames = new Set()) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (skipDirNames.has(ent.name)) continue;
        stack.push(full);
        continue;
      }
      if (exts.has(path.extname(ent.name))) out.push(full);
    }
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('www/xrk web-compat（http.js）', () => {
  it('存在 src/utils/http.js', () => {
    assert.ok(fs.existsSync(compatPath));
  });

  it('兼容层带降级：randomUUID / AbortSignal.timeout / structuredClone', () => {
    const src = fs.readFileSync(compatPath, 'utf8');
    assert.match(src, /globalThis\.crypto\?\.randomUUID/);
    assert.match(src, /Date\.now\(\)\.toString\(36\)/);
    assert.match(src, /AbortSignal\.timeout/);
    assert.match(src, /new AbortController/);
    assert.match(src, /structuredClone/);
    assert.match(src, /JSON\.parse\(\s*JSON\.stringify/);
  });

  it('randomId 返回非空字符串', () => {
    const id = randomId('t');
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 4);
  });

  it('unwrapSuccess：对象拍平', () => {
    const out = unwrapSuccess({ success: true, message: 'ok', assessments: [1], webVersion: '1' });
    assert.deepEqual(out, { assessments: [1], webVersion: '1' });
  });

  it('unwrapSuccess：数组在 data', () => {
    assert.deepEqual(unwrapSuccess({ success: true, message: 'ok', data: [1, 2] }), [1, 2]);
  });

  it('unwrapSuccess：失败抛错', () => {
    assert.throws(() => unwrapSuccess({ success: false, message: 'nope' }), /nope/);
  });

  it('abortTimeout 返回 AbortSignal', () => {
    const s = abortTimeout(50);
    assert.ok(s instanceof AbortSignal);
  });

  it('deepClone 拷贝对象', () => {
    const src = { a: 1, b: { c: 2 } };
    const out = deepClone(src);
    assert.deepEqual(out, src);
    assert.notEqual(out, src);
    assert.notEqual(out.b, src.b);
  });

  it('copyText 空串返回 false', async () => {
    assert.equal(await copyText(''), false);
  });

  it('downloadBlob 为函数', () => {
    assert.equal(typeof downloadBlob, 'function');
  });
});

describe('web-compat 扫描（xrk-www-compat）', () => {
  it('skill 写明禁裸 randomUUID / AbortSignal.timeout / 无降级 structuredClone', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    assert.match(skill, /randomUUID/);
    assert.match(skill, /AbortSignal\.timeout/);
    assert.match(skill, /structuredClone/);
    assert.match(skill, /abortTimeout|randomId|deepClone/);
  });

  it('core/**/www 源码（非 dist）无裸 API；兼容层可含降级用法', () => {
    const wwwRoots = [];
    const coreRoot = path.join(root, 'core');
    for (const coreName of fs.readdirSync(coreRoot)) {
      const www = path.join(coreRoot, coreName, 'www');
      if (fs.existsSync(www)) wwwRoots.push(www);
    }
    assert.ok(wwwRoots.length >= 1, '应至少有一个 core/*/www');

    /** 权威/内联兼容层：允许内部带降级地调用原生 API */
    const allowCompat = (rel) => {
      const n = rel.replace(/\\/g, '/');
      return (
        n.endsWith('/www/xrk/src/utils/http.js')
        || n.endsWith('/www/qqbot/src/compat.js')
        || /\/www\/[^/]+\/src\/compat\.js$/.test(n)
      );
    };

    /** 行级：无 typeof/?. 守卫的裸调用才算违规 */
    function bareHitsInText(text, rel) {
      /** @type {string[]} */
      const found = [];
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const prev = lines.slice(Math.max(0, i - 2), i).join('\n');
        const next = lines.slice(i, Math.min(lines.length, i + 8)).join('\n');

        if (/AbortSignal\.timeout\s*\(/.test(line)) {
          const guarded =
            /typeof\s+AbortSignal/.test(prev) || /typeof\s+AbortSignal/.test(line);
          if (!guarded) found.push(`${rel}:${i + 1} AbortSignal.timeout()`);
        }
        if (/(?<![\w$.?])crypto\.randomUUID\s*\(/.test(line) || /(?<![\w$.])crypto\.randomUUID\s*\(/.test(line)) {
          const guarded =
            /typeof\s+crypto/.test(prev) || /crypto\?\.randomUUID/.test(prev) || /crypto\.randomUUID\b/.test(prev)
            || /typeof\s+crypto/.test(line) || /crypto\?\.randomUUID/.test(line);
          // 「if (crypto.randomUUID) return crypto.randomUUID()」算有守卫
          if (!guarded && !/if\s*\([^)]*randomUUID/.test(prev + line)) {
            found.push(`${rel}:${i + 1} crypto.randomUUID()`);
          }
        }
        if (/(?<![\w$.])structuredClone\s*\(/.test(line)) {
          const hasFallback = /JSON\.parse\s*\(\s*JSON\.stringify/.test(next);
          const guarded = /typeof\s+structuredClone/.test(prev) || /typeof\s+structuredClone/.test(line);
          if (!guarded || !hasFallback) {
            // 无 typeof 守卫且无 JSON 降级 → 违规；有 typeof 但无降级也违规
            if (!hasFallback) found.push(`${rel}:${i + 1} structuredClone() 无 JSON 降级`);
          }
        }
      }
      return found;
    }

    /** @type {string[]} */
    const hits = [];
    for (const www of wwwRoots) {
      const files = walkFiles(www, WWW_EXT, new Set(['dist', 'node_modules', '.git']));
      for (const file of files) {
        const rel = path.relative(root, file);
        if (allowCompat(rel)) continue;
        const text = stripComments(fs.readFileSync(file, 'utf8'));
        hits.push(...bareHitsInText(text, rel.replace(/\\/g, '/')));
      }
    }
    assert.deepEqual(hits, [], hits.join('\n'));
  });

  it('src：无浏览器式裸 crypto.randomUUID（须 import node:crypto）', () => {
    const srcRoot = path.join(root, 'src');
    const files = walkFiles(srcRoot, SRC_EXT, new Set(['node_modules']));
    /** @type {string[]} */
    const hits = [];
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      if (/from\s+['"]node:crypto['"]/.test(raw) || /require\(\s*['"]node:crypto['"]\s*\)/.test(raw)) {
        continue;
      }
      const text = stripComments(raw);
      if (/(?<![\w$.])crypto\.randomUUID\s*\(/.test(text)) {
        hits.push(path.relative(root, file));
      }
    }
    assert.deepEqual(hits, [], hits.join('\n'));
  });

  it('分层：src 可用 AbortSignal.timeout（Node）；www 产品页由上一用例拦截', () => {
    const srcSample = path.join(root, 'src/utils/fetch-with-retry.ts');
    assert.ok(fs.existsSync(srcSample));
    assert.match(fs.readFileSync(srcSample, 'utf8'), /AbortSignal\.timeout/);
  });
});
