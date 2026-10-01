/**
 * 源码编码完整性门禁
 *
 * 背景：提交 cfccff36（2026-09-12 "chore: ship loop hardening"）在 Windows 上
 * 批量改写 src/factory/llm/ 五个文件时把中文降级成了 `?` 和 U+FFFD，
 * 提交里毫发无损，事后靠肉眼才发现——5 个文件 35 行、其中 6 处是用户可见的
 * 错误消息与日志（`DeepSeekLLMClient ?????: 429 ...`）。原因是纯文本里
 * `?` 无法与合法语法区分：?? 是空值合并、?. 是可选链、?: 是可选属性、
 * `?alt=` 是 URL query。前两版检测规则都因此淹没在误报里。
 *
 * 本测试只用两类零误报判据：
 *   1. U+FFFD —— 解码失败占位符，任何位置出现都是损坏
 *   2. 字符串字面量的「纯文本部分」里的 2+ 连续 ?（先剥离 ${...} 插值，
 *      所以 ?? 合并运算符不会混进来；再要求邻近有中文，排除 ?alt= / ?key=）
 *   3. 注释行里的 2+ 连续 ?，且 8 字符邻域内出现中文
 *
 * 已知盲区：单个中文被降级成单个 ?（如 `Foundry v1?`path=...`）检不出来，
 * 因为它与 `?alt=sse` 这类合法写法在文本上同形。那类只能靠 git 历史比对。
 * 扫描范围取「git 跟踪 + 未提交的新文件」：新文件在 commit 之前是最需要这道
 * 保护的阶段，而 `--others --exclude-standard` 仍能挡掉 dist / node_modules /
 * 本地 ignored Core。
 *
 * 本文件自身被排除在外：它的注释通篇在讨论 `??`，还持有成片的损坏 fixture，
 * 会被自己的规则命中。凡是「注入损坏样本做自测」的门禁，都必须把自己写进
 * 豁免名单，否则门禁一开就先报自己。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CJK = '\\u3000-\\u303F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uFF00-\\uFFEF';
const SCAN_EXT = /\.(ts|js|mjs|vue)$/;

/** 本门禁自身：持有损坏样本，扫自己会自触发（同文件头注释） */
const SELF = 'tests/unit/encoding-integrity.test.mjs';

/** 受版本控制的源文件：已跟踪 + 未提交的新文件；排除构建产物、本地 Core 与本门禁自身 */
function scannedSourceFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.js', '*.mjs', '*.vue'],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  ).toString();
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => SCAN_EXT.test(f))
    .filter((f) => f !== SELF)
    // 排除构建产物：dist 与前端打包的 www/*/dist/assets
    .filter((f) => !/(^|\/)(dist|node_modules|subserver|assets)\//.test(f))
    .filter((f) => !/\.(min|bundle)\.js$/.test(f));
}

/** 剥离模板串的 ${...} 插值，只留纯文本（插值里可能出现 ?? 空值合并） */
function stripInterpolations(str) {
  let out = '';
  let depth = 0;
  for (const ch of str) {
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    out += ch;
  }
  return out;
}

/**
 * 取出该行所有字符串字面量。tpl 区分模板串：只有模板串才需要剥离 ${} 插值，
 * 普通引号串里的 {} 是普通字符（如 JSON 片段），剥了会误伤。
 */
function stringLiterals(line) {
  const out = [];
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1] !== undefined) out.push({ tpl: false, text: m[1] });
    else if (m[2] !== undefined) out.push({ tpl: false, text: m[2] });
    else out.push({ tpl: true, text: m[3] });
  }
  return out;
}

const hasCjk = (s) => new RegExp(`[${CJK}]`).test(s);

/**
 * 整串就是一个（或几个）问号 = 有意写的占位符，不算损坏。
 * 例如 HomeView.vue 的 `|| '??'`（bot 无昵称无 uin 时的显示占位），
 * eb276008 与 HEAD 一致，确认是作者原意。损坏形态是问号混在句子里。
 */
const isQuestionPlaceholder = (t) => /^\?+$/.test(t.trim());

/** 检测单个文件，返回问题描述数组 */
export function inspectSource(fileText) {
  const problems = [];
  fileText.split(/\r?\n/).forEach((line, i) => {
    const at = `L${i + 1}`;
    if (/\uFFFD/.test(line)) {
      problems.push(`${at} [U+FFFD] 解码失败占位符：${line.trim().slice(0, 90)}`);
      return;
    }
    // 规则 2：字符串纯文本里的 2+ 连续 ?
    // 不要求邻近有中文——「gemini: 未配置 apiKey」整句被降级后一个 CJK 都不剩，
    // 加 CJK 约束反而漏报。JS 正则里不存在 `??`（a?? 不是合法量词），
    // 惰性量词写作 `}?`，所以字符串里的 2+ 连续 ? 几乎必然是损坏。
    for (const lit of stringLiterals(line)) {
      const plain = lit.tpl ? stripInterpolations(lit.text) : lit.text;
      if (isQuestionPlaceholder(plain)) continue;
      const idx = plain.search(/\?{2,}/);
      if (idx < 0) continue;
      problems.push(`${at} [字符串内??] ${line.trim().slice(0, 90)}`);
      break;
    }
    // 规则 3：注释行里的 2+ 连续 ? 且邻域有中文
    if (/^\s*(\*|\/\/|\/\*)/.test(line) && /\?{2,}/.test(line)) {
      if (hasCjk(line)) problems.push(`${at} [注释内??] ${line.trim().slice(0, 90)}`);
    }
  });
  return problems;
}

describe('源码编码完整性', () => {
  it('受版本控制的源文件（含未提交新文件）不含 U+FFFD（中文未被降级成替换字符）', () => {
    const files = scannedSourceFiles();
    assert.ok(files.length > 100, `跟踪源文件过少（${files.length}），扫描范围可能失效`);
    const bad = [];
    for (const f of files) {
      const abs = path.join(ROOT, f);
      if (!fs.existsSync(abs)) continue; // 索引里有、工作区已删（正常删文件时索引尚未同步）
      const text = fs.readFileSync(abs, 'utf8');
      if (/\uFFFD/.test(text)) {
        const ln = text.split(/\r?\n/).findIndex((l) => /\uFFFD/.test(l)) + 1;
        bad.push(`${f}:${ln}`);
      }
    }
    assert.deepEqual(bad, [], `以下文件含 U+FFFD（编码已损坏）：\n${bad.join('\n')}`);
  });

  it('受版本控制的源文件（含未提交新文件）不含「中文被降级成连续问号」', () => {
    const files = scannedSourceFiles();
    const bad = [];
    for (const f of files) {
      const abs = path.join(ROOT, f);
      if (!fs.existsSync(abs)) continue; // 索引里有、工作区已删（同上）
      const problems = inspectSource(fs.readFileSync(abs, 'utf8'));
      if (problems.length) bad.push(`${f}\n    ${problems.join('\n    ')}`);
    }
    assert.deepEqual(bad, [], `以下文件疑似编码损坏：\n${bad.join('\n')}`);
  });
});

describe('编码检测规则自身的判定（防止门禁被改坏成永远绿）', () => {
  it('能抓出被降级的中文', () => {
    const damaged = [
      "      throw new Error('gemini: ??? apiKey');",
      ' * - 认证：????? header `api-key`；?Microsoft Entra? bearer',
      ' * harness 无 adapter；`OpenAICompatible` ?????? Chat Completions ???',
    ].join('\n');
    assert.ok(inspectSource(damaged).length >= 3, '应至少报出 3 处');
  });

  it('不误报合法语法与 URL', () => {
    const legal = [
      'const raw = opts.timeoutMs ?? this.opTimeoutMs;',
      "    const name = this.config?.model ?? 'unknown';",
      "    if (body.response_format) { /* ok */ }",
      ' * - 流式：`:streamGenerateContent?alt=sse`',
      " * - 认证：优先 `x-goog-api-key`；`authMode: query` 时退回 `?key=`",
      "  let d = data?.items ?? [];",
      " *   method?: string,",
      "    reg: \"^#(全局)?(葵葵)?违禁词\",",
      " * - 经典部署：`/openai/deployments/{d}/chat/completions?api-version=2024-01-01`",
      " * @param {{ method?: string }} [opts]",
    ].join('\n');
    assert.deepEqual(inspectSource(legal), [], '合法写法不应被报出');
  });

  it('剥离插值后不再把 ${} 里的 ?? 当成损坏', () => {
    const tpl = "  return `${a}${b ?? c}${d?.e ?? 'x'}`;";
    assert.deepEqual(inspectSource(tpl), []);
  });

  it('整串问号是有意占位符，不算损坏', () => {
    // HomeView.vue：bot 无昵称无 uin 时回落到 '??'，eb276008 起一直如此
    const placeholder = "    return (bot.nickname || '').slice(0, 2) || String(bot.uin || '').slice(-2) || '??';";
    assert.deepEqual(inspectSource(placeholder), []);
    // 但问号混在句中仍是损坏
    assert.ok(inspectSource("    throw new Error('gemini: ??? apiKey');").length === 1);
  });

  it('注释里的 2+ 连续问号按「是否中文上下文」区分', () => {
    // 中文注释里的大片问号 = 降级
    assert.ok(inspectSource(' * - 认证：????? header `api-key`').length === 1);
    // 纯 ASCII 注释里的 ?? 多半是代码示例（空值合并），不报
    assert.deepEqual(inspectSource(' * use a ?? b when a is nullish'), []);
  });
});
