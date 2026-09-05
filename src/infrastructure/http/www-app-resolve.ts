/**
 * Core www 应用挂载决策（纯函数，可单测）
 *
 * ## www 子目录
 *
 * | 类型 | 判定 | 行为 |
 * |------|------|------|
 * | **零配置静态** | 无有效 sign | URL=`/${文件夹名}`，挂目录本体 |
 * | **有 sign** | 有效 sign.json | 可定制 URL / 产物 / 反代 / 与 server 合并的覆盖项 |
 *
 * ### 有 sign 时的运行方式
 *
 * | 开关 | 行为 |
 * |------|------|
 * | `serve: static` + `staticRoot: "."`（或无前端工程树） | **纯静态**：挂目录本体，不 build |
 * | `enabled: false` / `serve: static` + dist | **只 build、不启进程**，挂产物 |
 * | `enabled: true` / `serve: proxy` | **启进程 + 反代**（`FrontendLauncher`） |
 *
 * 与主服合并：`www-sign-merge.js`（sign 已写优先，未写回落 server）。
 * 权威说明：`docs/www-mount.md`。
 */
import path from 'node:path';
import fsSync from 'node:fs';

/** 前端工程静态产物相对路径候选（相对 www/<app>/；仅 signed 使用） */
export const WWW_BUILD_OUT_CANDIDATES = [
  'dist',
  'build',
  'out',
  path.join('.output', 'public'),
];

/**
 * @typedef {{ ok: boolean, value: object | null, error?: string }} WwwSignRead
 */

/**
 * @typedef {{
 *   kind: 'plain' | 'signed',
 *   mode: 'static' | 'proxy',
 *   staticRoot: string | null,
 *   mountPath: string,
 *   reason: string,
 *   warn?: string,
 *   sign: object | null,
 * }} WwwAppMountDecision
 */

/**
 * 读取并解析 sign.json。
 * - 文件不存在 → ok + value=null（普通静态）
 * - JSON 非法 / 非对象 → ok=false（按普通静态回退并记 error）
 *
 * @param {string} signPath
 * @returns {WwwSignRead}
 */
export function readWwwSignFile(signPath: any) {
  try {
    if (!fsSync.existsSync(signPath)) {
      return { ok: true, value: null };
    }
    const raw = fsSync.readFileSync(signPath, 'utf8');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, value: null, error: 'sign.json 根须为对象' };
    }
    return { ok: true, value };
  } catch (err: any) {
    return {
      ok: false,
      value: null,
      error: err?.message || String(err),
    };
  }
}

/**
 * 前端工程是否走反代（与静态互斥）。普通静态（sign=null）恒为 false。
 *
 * | serve           | enabled     | 结果     |
 * |-----------------|-------------|----------|
 * | static / dist   | 任意        | 不反代   |
 * | proxy / dev     | 未关        | 反代     |
 * | （未写）        | false       | 不反代   |
 * | （未写）        | true / 缺省 | 反代     |
 *
 * @param {object | null | undefined} sign
 * @returns {boolean}
 */
export function shouldProxyFrontend(sign: any) {
  if (!sign || typeof sign !== 'object') return false;
  if (sign.enabled === false) return false;

  const serve = String(sign.serve || '').toLowerCase().trim();
  if (serve === 'static' || serve === 'dist') return false;
  if (serve === 'proxy' || serve === 'dev') return true;

  return true;
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function hasIndexHtml(dir: any) {
  try {
    return fsSync.existsSync(path.join(dir, 'index.html'));
  } catch {
    return false;
  }
}

/**
 * 粗判「Vite/前端源码树尚未 build」（缺产物时不应挂源码）。
 *
 * @param {string} appDir
 * @returns {boolean}
 */
export function looksLikeFrontendSourceTree(appDir: any) {
  try {
    if (!fsSync.existsSync(path.join(appDir, 'package.json'))) return false;
    if (hasIndexHtml(appDir)) {
      const html = fsSync.readFileSync(path.join(appDir, 'index.html'), 'utf8');
      if (/src=["']\/src\//i.test(html) || /src=["']\.\/src\//i.test(html)) {
        return true;
      }
    }
    return (
      fsSync.existsSync(path.join(appDir, 'vite.config.js')) ||
      fsSync.existsSync(path.join(appDir, 'vite.config.ts')) ||
      fsSync.existsSync(path.join(appDir, 'vite.config.mts')) ||
      fsSync.existsSync(path.join(appDir, 'vite.config.mjs'))
    );
  } catch {
    return false;
  }
}

/**
 * @param {string} appDir
 * @param {string} candidateAbs
 * @returns {boolean}
 */
function isInsideAppDir(appDir: any, candidateAbs: any) {
  let base;
  let target;
  try {
    base = fsSync.realpathSync(appDir);
  } catch {
    base = path.resolve(appDir);
  }
  try {
    target = fsSync.existsSync(candidateAbs)
      ? fsSync.realpathSync(candidateAbs)
      : path.resolve(candidateAbs);
  } catch {
    target = path.resolve(candidateAbs);
  }
  const rel = path.relative(base, target);
  if (!rel || rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).includes('..');
}

/**
 * 解析静态文件根目录。
 *
 * - **零配置静态**（无 sign）：始终挂应用目录本体，不探测 dist。
 * - **有 sign**：`staticRoot`/`outDir` → dist/build/out/…；显式 `"."` 挂目录本体（纯静态）。
 *
 * @param {string} appDir
 * @param {object | null} [sign]
 * @returns {{ root: string, via: string, warn?: string }}
 */
export function resolveWwwStaticRoot(appDir: any, sign: any = null) {
  if (!sign || typeof sign !== 'object') {
    return { root: appDir, via: '.' };
  }

  const fromSign =
    (sign.staticRoot && String(sign.staticRoot).trim()) ||
    (sign.outDir && String(sign.outDir).trim()) ||
    '';
  if (fromSign === '.' || fromSign === './') {
    return {
      root: appDir,
      via: '.',
      warn: hasIndexHtml(appDir) ? undefined : 'staticRoot=. 但目录无 index.html',
    };
  }

  const preferred = [];
  if (fromSign) preferred.push(fromSign);
  for (const c of WWW_BUILD_OUT_CANDIDATES) {
    if (!preferred.includes(c)) preferred.push(c);
  }

  for (const rel of preferred) {
    const abs = path.resolve(appDir, rel);
    if (!isInsideAppDir(appDir, abs)) continue;
    if (hasIndexHtml(abs)) {
      return { root: abs, via: rel.replace(/\\/g, '/') };
    }
  }

  const warn = looksLikeFrontendSourceTree(appDir)
    ? '前端工程未找到 dist/build 等产物，暂挂源码目录；请先 pnpm build，或设置 sign.staticRoot'
    : undefined;

  return { root: appDir, via: '.', warn };
}

/**
 * 有 sign 的静态挂载根是否可用（含纯静态挂目录本体）。
 *
 * @param {string} appDir
 * @param {object | null | undefined} sign
 * @param {{ root?: string, via?: string } | null | undefined} resolved
 * @returns {boolean}
 */
export function isWwwSignedStaticRootOk(appDir: any, sign: any, resolved: any) {
  if (!resolved?.root) return false;
  if (resolved.via && resolved.via !== '.') return true;
  const hint = String(sign?.staticRoot || sign?.outDir || '').trim();
  if (hint === '.' || hint === './') return true;
  if (looksLikeFrontendSourceTree(appDir)) return false;
  return hasIndexHtml(resolved.root);
}

/**
 * 对外 URL 挂载路径。
 *
 * - **零配置静态**（无 sign）：恒为 `/${文件夹名}`。
 * - **有 sign**（含纯静态）：`proxy.mount` → `mount` → `/${id}` → 回退 `/${文件夹名}`。
 *
 * @param {string} appDirName www 下文件夹名
 * @param {object | null | undefined} sign 有效 sign 对象；null=零配置静态
 * @returns {string} 形如 `/example`（无尾斜杠）
 */
export function resolveWwwPublicMountPath(appDirName: any, sign: any = null) {
  const fallback = `/${String(appDirName || '').replace(/^\/+|\/+$/g, '') || 'app'}`;
  if (!sign || typeof sign !== 'object') return fallback;

  const fromProxy =
    sign.proxy && typeof sign.proxy === 'object' && sign.proxy.mount != null
      ? String(sign.proxy.mount).trim()
      : '';
  const fromMount = sign.mount != null ? String(sign.mount).trim() : '';
  const fromId = sign.id != null ? String(sign.id).trim() : '';

  let raw = fromProxy || fromMount || (fromId ? `/${fromId}` : '') || fallback;
  if (!raw.startsWith('/')) raw = `/${raw}`;
  raw = raw.replace(/\/+$/, '') || '/';
  if (raw.includes('..') || raw === '/') return fallback;
  return raw;
}

/**
 * @param {string} mountPath
 * @returns {string}
 */
export function wwwMountPathRootSegment(mountPath: any) {
  const s = String(mountPath || '').replace(/^\/+/, '').split('/')[0] || '';
  return s;
}

/**
 * 综合决策：零配置静态 | 有 sign（纯静态 / 产物静态 / 反代）。
 *
 * @param {string} appDir www 下某一应用目录绝对路径
 * @param {string} [signPath] 默认 `appDir/sign.json`
 * @returns {WwwAppMountDecision}
 */
export function resolveWwwAppMount(appDir: any, signPath: any = path.join(appDir, 'sign.json')) {
  const appDirName = path.basename(appDir);
  const read = readWwwSignFile(signPath);

  // 无 sign 或损坏 → 零配置静态
  if (!read.ok || !read.value) {
    const resolved = resolveWwwStaticRoot(appDir, null);
    const mountPath = resolveWwwPublicMountPath(appDirName, null);
    return {
      kind: 'plain',
      mode: 'static',
      staticRoot: resolved.root,
      mountPath,
      reason: !read.ok
        ? `sign 无效，按零配置静态挂载 (${read.error})`
        : '零配置静态（无 sign.json）',
      warn: !read.ok ? read.error : undefined,
      sign: null,
    };
  }

  const sign = read.value;
  const mountPath = resolveWwwPublicMountPath(appDirName, sign);

  if (shouldProxyFrontend(sign)) {
    return {
      kind: 'signed',
      mode: 'proxy',
      staticRoot: null,
      mountPath,
      reason: '有 sign：反代（serve=proxy/dev，或未写 serve 且 enabled 未关）',
      sign,
    };
  }

  const resolved = resolveWwwStaticRoot(appDir, sign);
  const serve = String(sign.serve || '').toLowerCase();
  const hint = String(sign.staticRoot || sign.outDir || '').trim();
  let reason = '有 sign：静态托管';
  if (hint === '.' || hint === './' || (resolved.via === '.' && !looksLikeFrontendSourceTree(appDir))) {
    reason = '有 sign：纯静态（挂目录本体）';
  } else if (sign.enabled === false) {
    reason = '有 sign：enabled=false，静态托管产物';
  } else if (serve === 'static' || serve === 'dist') {
    reason = '有 sign：serve=static，静态托管产物';
  }

  return {
    kind: 'signed',
    mode: 'static',
    staticRoot: resolved.root,
    mountPath,
    reason: `${reason} → ${resolved.via}`,
    warn: resolved.warn,
    sign,
  };
}

/**
 * @deprecated 请用 `shouldProxyFrontend(readWwwSignFile(path).value)`
 * @param {string} signPath
 */
export function isActiveFrontendSign(signPath: any) {
  const read = readWwwSignFile(signPath);
  if (!read.ok) return false;
  return shouldProxyFrontend(read.value);
}

/**
 * @deprecated 请用 `resolveWwwStaticRoot(dir, null).root`（普通静态=目录本体）
 * @param {string} subDirPath
 */
export function resolveWwwAppStaticRoot(subDirPath: any) {
  return resolveWwwStaticRoot(subDirPath, null).root;
}
