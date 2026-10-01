#!/usr/bin/env node
/**
 * 未使用声明门禁：tsc --noUnusedLocals / --noUnusedParameters，只对「框架自身」生效。
 *
 * 为什么不用 tsconfig 开关：
 *   noUnusedLocals 是全局开关，会被 core/system-Core 的历史签名卡住——
 *   express handler 的 req / app、错误中间件的 $_1 / $_2、工具类的 context
 *   这些参数位置必需、删了签名就变。框架自身必须干净，业务 Core 不强制，
 *   这条边界在这里写死。
 *
 * 为什么用 tsc 而不是自己写正则：
 *   tsc 能正确处理 import alias、类型、值/类型同名、条件分支；
 *   自己扫 import 正则必然在 `import * as X`、re-export、字符串内标识符上误判。
 *   （本仓库已经因为「点号前是属性访问」误删过 1265 行启动链路代码。）
 *
 * 用法：
 *   node tests/checks/unused-decls-check.mjs              门禁：src/ 有未使用声明 → exit 1
 *   node tests/checks/unused-decls-check.mjs --self-test  只验过滤器（不起 tsc，毫秒级）
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** tsc 的未使用声明诊断码：6133 值/局部，6196 类型声明 */
const UNUSED_CODE = /\berror TS(?:6133|6196):/
/** 框架自身路径；正反斜杠都认（Windows 下 tsc 可能输出反斜杠） */
const OWNED_PATH = /^(?:src[/\\]|app\.ts\(|start\.ts\(|debug\.ts\()/

/** 从 tsc 原始输出里挑出「属于框架自身」的未使用声明行 */
export function selectOwnedUnused(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && OWNED_PATH.test(line) && UNUSED_CODE.test(line))
}

const FIXTURES = {
  pass: [
    "src/infrastructure/config/config.ts(10,7): error TS6133: 'tmp' is declared but its value is never read.",
    'src\\utils\\agent-workspace-paths.ts(45,13): error TS6196: "RecipesDir" is declared but never used.',
  ],
  mustIgnore: [
    "core/system-Core/http/core.ts(354,49): error TS6133: 'req' is declared but its value is never read.",
    "src/utils/config.ts(1,1): error TS2304: Cannot find name 'Missing'.",
    "tests/unit/config-alignment.test.mjs(8,3): error TS6133: 'x' is declared but its value is never read.",
    // 消息里出现 unused 字样，但诊断码不是 6133/6196 —— 防有人把过滤改成 /unused/ 字面匹配
    "src/utils/foo.ts(3,1): error TS2554: Expected 1 arguments, but got 2. See the unused import list.",
    // 路径里带 src/ 但根本不是 tsc 诊断行（pnpm/pip 一类工具的噪声）
    'npm WARN deprecated src/legacy-pkg@1.0.0: moved to src/next-pkg',
  ],
}

function runSelfTest() {
  const mixed = [...FIXTURES.pass, ...FIXTURES.mustIgnore].join('\n')
  const got = selectOwnedUnused(mixed)

  const checks = [
    ['只保留框架自身的未使用声明', got.length === FIXTURES.pass.length, `期望 ${FIXTURES.pass.length} 行，实得 ${got.length}`],
    ['识别 TS6133', got.some((l) => l.includes('TS6133')), '缺少 TS6133'],
    ['识别 TS6196', got.some((l) => l.includes('TS6196')), '缺少 TS6196'],
    ['识别反斜杠路径（Windows）', got.some((l) => l.includes('src\\')), '反斜杠路径未被识别'],
    ['排除 core/', !got.some((l) => l.startsWith('core/')), 'core/ 未被排除'],
    ['排除 tests/', !got.some((l) => l.startsWith('tests/')), 'tests/ 未被排除'],
    ['排除非 unused 诊断码', !got.some((l) => l.includes('TS2304')), 'TS2304 不该被选中'],
    ['CRLF 输入', selectOwnedUnused(`${FIXTURES.pass[0]}\r\n`).length === 1, 'CRLF 解析失败'],
    ['空输入', selectOwnedUnused('').length === 0, '空输入应返回空'],
    ['undefined 输入', selectOwnedUnused(undefined).length === 0, 'undefined 应返回空'],
  ]

  let failed = 0
  for (const [name, ok, detail] of checks) {
    if (!ok) {
      failed += 1
      console.error(`  ✖ ${name} — ${detail}`)
    }
  }
  if (failed > 0) {
    console.error(`\n[unused-decls] 过滤器自测 ${failed}/${checks.length} 项失败`)
    return 1
  }
  console.log(`[unused-decls] 过滤器自测 ${checks.length}/${checks.length} 通过`)
  return 0
}

function runGate() {
  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tscBin)) {
    console.error(`[unused-decls] 找不到 ${tscBin}，先执行 pnpm install`)
    return 1
  }

  const res = spawnSync(
    process.execPath,
    [tscBin, '-p', 'tsconfig.json', '--noUnusedLocals', '--noUnusedParameters', '--noEmit'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`

  // 防假绿一：tsc 没跑起来（缺 tsconfig / 崩溃）时输出里会有非诊断内容。
  // 此时若直接「过滤后为空 → 通过」，门禁就成了永远绿。
  if (res.error) {
    console.error(`[unused-decls] tsc 执行失败：${res.error.message}`)
    return 1
  }
  if (!/error TS\d+/.test(output) && output.trim()) {
    console.error('[unused-decls] tsc 未产生任何 TS 诊断，输出如下（门禁无法判定，判为失败）：')
    console.error(output.trim().slice(0, 2000))
    return 1
  }

  const violations = selectOwnedUnused(output)
  const coreIgnored = (output.match(/^core[/\\].*error TS(?:6133|6196):/gm) ?? []).length

  if (violations.length > 0) {
    console.error(`[unused-decls] ❌ src/ 有 ${violations.length} 处未使用声明：\n`)
    for (const line of violations) console.error(`  ${line}`)
    console.error('\n修复：删除未使用的 import / 局部；签名位置必需的参数改用 `_` 前缀（TS 豁免）。')
    return 1
  }

  console.log('[unused-decls] ✅ 框架自身（src/ + app/start/debug）无未使用声明')
  if (coreIgnored > 0) {
    console.log(`[unused-decls] （core/ 有 ${coreIgnored} 处历史签名参数，按约定不计入本门禁）`)
  }
  return 0
}

const isSelfTest = process.argv.includes('--self-test')
process.exit(isSelfTest ? runSelfTest() : runGate())
