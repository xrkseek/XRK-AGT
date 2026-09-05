/**
 * 前端工程静态模式：只 build、不启进程。
 *
 * 前端工程一共两种（见 docs/www-mount.md）：
 * 1. enabled=false / serve=static → 本模块仅在 Bootstrap / `pnpm run build:www` 按 stale build；挂载不编
 * 2. enabled=true  / serve=proxy  → FrontendLauncher：启进程 + 反代（不走这里）
 *
 * Windows 下不能 `execFile('pnpm')`（ENOENT）；统一走 `#utils/command-spawn.js` 解析。
 *
 * 2c2g：勿在 AGT 已加载后同机 Vite（易 OOM）。构建只在启动过程
 * `buildSignedStaticWwwBeforeRuntime`（Bootstrap）或 `pnpm run build:www`。
 */
import path from 'node:path';
import fsSync from 'node:fs';
import { spawn } from 'node:child_process';
import RuntimeUtil from '#utils/runtime-util.js';
import paths from '#utils/paths.js';
import {
  getPnpmInstallHint,
  resolveCommandSpawn,
} from '#utils/command-spawn.js';
import {
  resolveWwwAppMount,
  resolveWwwStaticRoot,
} from '#infrastructure/http/www-app-resolve.js';

const BUILD_WALK_SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.vite',
  '.turbo',
  'coverage',
  'dist-ssr',
]);

function wwwBuildLog(level: any, message: any) {
  RuntimeUtil.makeLog(level, message, 'AgentRuntime');
}

/**
 * @param {unknown} raw
 * @param {string} appDir
 * @returns {{ command: string, args: string[], cwd: string, env: Record<string, string> } | null}
 */
export function normalizeWwwBuildSpec(raw: any, appDir: any) {
  if (!raw || typeof raw !== 'object') return null;
  const command = raw.command != null ? String(raw.command).trim() : '';
  if (!command) return null;
  const args = Array.isArray(raw.args) ? raw.args.map((a: any) => String(a)) : [];
  const cwd = raw.cwd ? path.resolve(appDir, String(raw.cwd)) : appDir;
  const env =
    raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
      ? Object.fromEntries(
          Object.entries(raw.env).map(([k, v]: any) => [String(k), v == null ? '' : String(v)]),
        )
      : {};
  return { command, args, cwd, env };
}

/**
 * 静态模式用的 build 命令：`sign.build`，否则有 package.json 时默认 `pnpm build`。
 *
 * @param {object} sign
 * @param {string} appDir
 */
export function resolveSignedStaticBuildSpec(sign: any, appDir: any) {
  const fromSign = normalizeWwwBuildSpec(sign?.build, appDir);
  if (fromSign) return fromSign;
  if (fsSync.existsSync(path.join(appDir, 'package.json'))) {
    return { command: 'pnpm', args: ['build'], cwd: appDir, env: {} };
  }
  return null;
}

/**
 * 目录/文件树中最新 mtime（ms）。跳过 node_modules / dist 等。
 * @param {string} target
 * @param {{ maxFiles?: number }} [opts]
 * @returns {number} 0 表示不可用
 */
export function maxMtimeMs(target: any, opts: any = {}) {
  const maxFiles = opts.maxFiles ?? 8000;
  let newest = 0;
  let seen = 0;

  /** @param {string} abs */
  function visit(abs: any) {
    if (seen >= maxFiles) return;
    let st;
    try {
      st = fsSync.lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isFile()) {
      seen += 1;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      return;
    }
    if (!st.isDirectory()) return;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    let entries;
    try {
      entries = fsSync.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (seen >= maxFiles) return;
      if (BUILD_WALK_SKIP.has(ent.name)) continue;
      visit(path.join(abs, ent.name));
    }
  }

  visit(target);
  return newest;
}

/**
 * 参与「是否过期」判断的输入：配置文件 + src/public。
 * @param {string} appDir
 * @returns {number}
 */
export function maxWwwSourceMtimeMs(appDir: any) {
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.ts',
    'vite.config.cjs',
    'index.html',
    'sign.json',
    'tsconfig.json',
    'tsconfig.app.json',
    'jsconfig.json',
  ];
  let newest = 0;
  for (const rel of files) {
    const abs = path.join(appDir, rel);
    if (!fsSync.existsSync(abs)) continue;
    try {
      const t = fsSync.statSync(abs).mtimeMs;
      if (t > newest) newest = t;
    } catch {
      /* ignore */
    }
  }
  for (const rel of ['src', 'public']) {
    const abs = path.join(appDir, rel);
    if (!fsSync.existsSync(abs)) continue;
    const t = maxMtimeMs(abs);
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * @param {string} appDir
 * @param {object} sign
 * @param {{ root?: string, via?: string } | null | undefined} [resolved]
 */
export function resolveSignedStaticOutDir(appDir: any, sign: any, resolved: any) {
  if (resolved?.via && resolved.via !== '.' && resolved.root) {
    return resolved.root;
  }
  const rel =
    (sign?.staticRoot && String(sign.staticRoot).trim()) ||
    (sign?.outDir && String(sign.outDir).trim()) ||
    'dist';
  return path.resolve(appDir, rel);
}

/**
 * 产物是否落后于源码（缺 index.html 或源码更新 → 需要 build）。
 * @param {string} appDir
 * @param {object} sign
 * @param {{ root?: string, via?: string } | null | undefined} [resolved]
 */
export function isSignedStaticBuildStale(appDir: any, sign: any, resolved: any) {
  if (!appDir) return true;
  const outDir = resolveSignedStaticOutDir(appDir, sign, resolved);
  const indexHtml = path.join(outDir, 'index.html');
  if (!fsSync.existsSync(indexHtml)) return true;

  let distNewest = 0;
  try {
    distNewest = fsSync.statSync(indexHtml).mtimeMs;
  } catch {
    return true;
  }
  const assetsNewest = maxMtimeMs(outDir);
  if (assetsNewest > distNewest) distNewest = assetsNewest;
  if (!distNewest) return true;

  const srcNewest = maxWwwSourceMtimeMs(appDir);
  if (!srcNewest) return false;
  // 文件系统时间精度容差
  return srcNewest > distNewest + 2;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string> }} opts
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function runResolvedCommand(command: any, args: any, opts: any) {
  let spawnSpec;
  try {
    spawnSpec = resolveCommandSpawn(command, args, opts.cwd);
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve: any, reject: any) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, BROWSER: 'none' },
      shell: spawnSpec.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: any) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: any) => {
      stderr += chunk;
    });

    child.on('error', (err: any) => {
      if (err?.code === 'ENOENT' || err?.code === 'EINVAL') {
        const hint = command === 'pnpm' ? `，请执行: ${getPnpmInstallHint()}` : '';
        reject(new Error(`${command} 未安装或不在 PATH 中${hint}`));
        return;
      }
      reject(err);
    });

    child.on('close', (code: any) => {
      if (code === 0) {
        resolve({ stdout, stderr, code: 0 });
        return;
      }
      const detail = (stderr || stdout || '').trim().slice(0, 800);
      const err: any = new Error(
        `${command} ${args.join(' ')} 退出码 ${code ?? 'unknown'}${detail ? ` — ${detail}` : ''}`,
      );
      err.stdout = stdout;
      err.stderr = stderr;
      err.code = code;
      reject(err);
    });
  });
}

/**
 * @param {string} appDir
 * @param {object} sign
 * @param {string} [label]
 */
export async function runSignedStaticBuild(appDir: any, sign: any, label: any = appDir) {
  const spec = resolveSignedStaticBuildSpec(sign, appDir);
  if (!spec) {
    wwwBuildLog('warn', `${label}: 静态模式无法 build（需 package.json 或 sign.build）`);
    return false;
  }

  const display = `${spec.command} ${spec.args.join(' ')}`.trim();
  wwwBuildLog('info', `前端工程静态模式：构建产物（不启进程）: ${label} (${display})`);

  try {
    const { stdout, stderr } = (await runResolvedCommand(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
    })) as { stdout?: string; stderr?: string };
    if (stdout?.trim()) {
      wwwBuildLog('debug', `build stdout (${label}): ${stdout.trim().slice(-800)}`);
    }
    if (stderr?.trim()) {
      wwwBuildLog('debug', `build stderr (${label}): ${stderr.trim().slice(-800)}`);
    }
    wwwBuildLog('info', `前端工程构建完成: ${label}`);
    return true;
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    wwwBuildLog(
      'error',
      `前端工程构建失败: ${label} — ${String(msg).trim().slice(0, 500)}`,
    );
    return false;
  }
}

/**
 * 启动过程：按 stale 构建各 Core 有 sign 的静态前端（挂载阶段不 build）。
 * `XRK_SKIP_WWW_BUILD=1` 跳过。
 *
 * @param {{ log?: (level: string, msg: string) => void }} [opts]
 * @returns {Promise<{ skipped: boolean, built: string[], failed: string[] }>}
 */
export async function buildSignedStaticWwwBeforeRuntime(opts: any = {}) {
  if (process.env.XRK_SKIP_WWW_BUILD === '1') {
    return { skipped: true, built: [], failed: [] };
  }

  const log =
    typeof opts.log === 'function'
      ? opts.log
      : (level: any, msg: any) => wwwBuildLog(level, msg);

  const built = [];
  const failed = [];
  const coreDirs = await paths.getCoreDirs();

  for (const coreDir of coreDirs) {
    const coreName = path.basename(coreDir);
    const wwwDir = path.join(paths.coreSource, coreName, 'www');
    if (!fsSync.existsSync(wwwDir)) continue;
    let entries = [];
    try {
      entries = fsSync.readdirSync(wwwDir, { withFileTypes: true }).filter((e: any) => e.isDirectory());
    } catch {
      continue;
    }

    for (const ent of entries) {
      const appDir = path.join(wwwDir, ent.name);
      const decision = resolveWwwAppMount(appDir);
      if (decision.kind !== 'signed' || decision.mode !== 'static' || !decision.sign) continue;
      if (!resolveSignedStaticBuildSpec(decision.sign, appDir)) continue;

      const label = decision.mountPath || `/${ent.name}`;
      const resolved = resolveWwwStaticRoot(appDir, decision.sign);
      if (!isSignedStaticBuildStale(appDir, decision.sign, resolved)) {
        log('info', `启动过程：前端产物已是最新，跳过 ${label}`);
        continue;
      }

      log('info', `启动过程：构建前端 ${label}（AGT 尚未加载）`);
      const ok = await runSignedStaticBuild(appDir, decision.sign, label);
      if (ok) built.push(label);
      else failed.push(label);
    }
  }

  return { skipped: false, built, failed };
}
