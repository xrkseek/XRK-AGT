/**
 * 类型卫生：禁止 @ts-ignore；@ts-expect-error 仅允许「缺官方类型」类注释；
 * as unknown as 应优先改为最小接口 / 直接类型断言。
 * 门禁：`pnpm test:fast`（见 tests/run.mjs）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = path.join(root, 'src');

/** 允许的 @ts-expect-error 原因关键词（缺 @types / 无官方声明） */
const TS_EXPECT_ALLOW = [
  'no @types/',
  '无 @types/',
  '无官方类型',
  '无类型声明',
  'no DefinitelyTyped',
  'express 无',
  'node-schedule',
  'compression 无',
  'no @types/ws',
  'no @types/multer',
  'no @types/express',
];

function walkTs(dir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === 'dist') continue;
        stack.push(full);
        continue;
      }
      if (/\.tsx?$/.test(ent.name)) out.push(full);
    }
  }
  return out;
}

function rel(p) {
  return path.relative(root, p).replace(/\\/g, '/');
}

describe('src TypeScript cast hygiene', () => {
  const files = walkTs(srcRoot);

  it('has zero @ts-ignore', () => {
    /** @type {string[]} */
    const hits = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (/@ts-ignore\b/.test(text)) hits.push(rel(file));
    }
    assert.deepEqual(hits, [], `forbidden @ts-ignore:\n${hits.join('\n')}`);
  });

  it('@ts-expect-error only for missing package types', () => {
    /** @type {string[]} */
    const bad = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/@ts-expect-error\b/.test(line)) continue;
        const ok = TS_EXPECT_ALLOW.some((k) => line.includes(k));
        if (!ok) bad.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      }
    }
    assert.deepEqual(bad, [], `narrow @ts-expect-error comment:\n${bad.join('\n')}`);
  });

  it('as unknown as count stays within budget (prefer minimal interfaces)', () => {
    let count = 0;
    /** @type {string[]} */
    const samples = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const matches = text.match(/\bas unknown as\b/g);
      if (!matches?.length) continue;
      count += matches.length;
      if (samples.length < 12) samples.push(`${rel(file)} ×${matches.length}`);
    }
    // 2026-09-12 typecheck 绿灯后含 AgentRuntime host / 渲染器边界断言；超限须继续收窄
    const MAX = 45;
    assert.ok(
      count <= MAX,
      `as unknown as count ${count} > ${MAX}\n${samples.join('\n')}`,
    );
  });
});
