/**
 * coding-style / xrk-dev-requirements 门禁：
 * - constructor 内勿建 Map/Set/空对象缓存容器
 * - 禁 global.AgentRuntime / global.msgSegment（应用裸名 + setRuntimeGlobal）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(root, 'src');

function walkTs(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTs(full, out);
    else if (ent.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 粗提取 constructor 方法体（不处理嵌套类；够拦主路径违规） */
function extractConstructors(src) {
  const bodies = [];
  const re = /constructor\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i++];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
    }
    bodies.push(src.slice(m.index, i));
  }
  return bodies;
}

const CACHE_IN_CTOR =
  /this\.\w+\s*=\s*(?:new\s+(?:Map|Set)\s*\(|Object\.create\s*\(\s*null\s*\)|\{\s*\}|\[\s*\])/;

describe('coding-style constructor / globals', () => {
  it('src constructors do not create cache Map/Set/{} / Object.create(null)', () => {
    const hits = [];
    for (const file of walkTs(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const body of extractConstructors(text)) {
        if (CACHE_IN_CTOR.test(body)) {
          hits.push(path.relative(root, file).replace(/\\/g, '/'));
          break;
        }
      }
    }
    assert.deepEqual(hits, [], `constructor cache containers:\n${hits.join('\n')}`);
  });

  it('src has no global.AgentRuntime / global.msgSegment', () => {
    const hits = [];
    for (const file of walkTs(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/\bglobal\.(AgentRuntime|msgSegment)\b/.test(text)) {
        hits.push(path.relative(root, file).replace(/\\/g, '/'));
      }
    }
    assert.deepEqual(hits, [], hits.join('\n'));
  });
});
