import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import paths from '#utils/paths.js';
import { statDirs, statFiles } from '#utils/core-fs.js';
import { getPnpmInstallHint, spawnCommand as spawnCommandBase } from '#utils/command-spawn.js';

const require = createRequire(import.meta.url);
const { findSystemBrowser } = require('#utils/system-browser.cjs');

/** Playwright 1.58+ CfT 仅 cdn.playwright.dev 提供 builds/cft/ 路径（npmmirror 未同步） */
const PLAYWRIGHT_CDN = 'https://cdn.playwright.dev';
const PLAYWRIGHT_DOWNLOAD_ENV = {
  PLAYWRIGHT_DOWNLOAD_HOST: PLAYWRIGHT_CDN,
  PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST: PLAYWRIGHT_CDN
};
const DEPS_READY_MARKER = '.xrk-deps-ready';

/** @returns {Record<string, string>} */
export function getBrowserDownloadEnv(overrides = {}) {
  return {
    PUPPETEER_SKIP_DOWNLOAD: process.env.PUPPETEER_SKIP_DOWNLOAD ?? 'true',
    ...overrides
  };
}

function depsReadyMarkerPath(nodeModulesPath) {
  return path.join(nodeModulesPath, DEPS_READY_MARKER);
}

function isDepsInstallComplete(nodeModulesPath) {
  return statFiles([depsReadyMarkerPath(nodeModulesPath)])[0];
}

async function markDepsInstallComplete(nodeModulesPath) {
  await fs.mkdir(nodeModulesPath, { recursive: true });
  await fs.writeFile(depsReadyMarkerPath(nodeModulesPath), `${Date.now()}\n`);
}

export function spawnCommand(command, args, cwd, extraEnv = {}) {
  return spawnCommandBase(command, args, cwd, {
    ...getBrowserDownloadEnv(extraEnv),
    ...extraEnv
  });
}

export { getPnpmInstallHint };

let pnpmInstallChain = Promise.resolve();

export function spawnPnpmInstall(cwd) {
  const install = pnpmInstallChain.then(() =>
    spawnCommand('pnpm', ['install'], cwd, { CI: 'true' })
  );
  pnpmInstallChain = install.catch(() => {});
  return install;
}

/** @param {string} depName @param {string} nodeModulesPath @param {string} packageRoot */
export function isPackageInstalled(depName, nodeModulesPath, packageRoot) {
  const segments = depName.split('/');
  const directPath = path.join(nodeModulesPath, ...segments);
  try {
    const stat = fsSync.lstatSync(directPath);
    if ((stat.isDirectory() || stat.isSymbolicLink()) && fsSync.existsSync(path.join(directPath, 'package.json'))) {
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    createRequire(path.join(packageRoot, 'package.json')).resolve(`${depName}/package.json`);
    return true;
  } catch {
    return false;
  }
}

export function getMissingDependencies(depNames, nodeModulesPath, packageRoot) {
  if (!statDirs([nodeModulesPath])[0]) return depNames;
  return depNames.filter((dep) => !isPackageInstalled(dep, nodeModulesPath, packageRoot));
}

/**
 * @returns {Promise<{
 *   playwrightInstalled: boolean,
 *   browserInstalled: boolean,
 *   executablePath: string | null,
 *   systemBrowserPath: string | null,
 *   needsBrowserReminder: boolean
 * }>}
 */
export async function getBrowserStatus(rootDir = process.cwd()) {
  const systemBrowserPath = findSystemBrowser();
  const nodeModulesPath = path.join(rootDir, 'node_modules');

  if (!isPackageInstalled('playwright', nodeModulesPath, rootDir)) {
    return {
      playwrightInstalled: false,
      browserInstalled: false,
      executablePath: null,
      systemBrowserPath,
      needsBrowserReminder: !systemBrowserPath
    };
  }

  try {
    const { chromium } = await import('playwright');
    const executablePath = chromium.executablePath();
    const browserInstalled = fsSync.existsSync(executablePath);
    const canLaunch = !!(systemBrowserPath || browserInstalled);
    return {
      playwrightInstalled: true,
      browserInstalled,
      executablePath,
      systemBrowserPath,
      needsBrowserReminder: !canLaunch
    };
  } catch {
    return {
      playwrightInstalled: false,
      browserInstalled: false,
      executablePath: null,
      systemBrowserPath,
      needsBrowserReminder: !systemBrowserPath
    };
  }
}

/** 引导阶段记录可用浏览器（系统路径同步检测，避免首次截图时才打 Found） */
export async function logBrowserEnvironment(logger, rootDir = process.cwd()) {
  const systemBrowserPath = findSystemBrowser();
  if (systemBrowserPath) {
    await logger.success(`渲染浏览器: 系统 ${systemBrowserPath}`);
    return;
  }

  const status = await getBrowserStatus(rootDir);
  if (status.browserInstalled && status.executablePath) {
    await logger.success(`渲染浏览器: Playwright ${status.executablePath}`);
  } else if (status.needsBrowserReminder) {
    await logger.warning('渲染浏览器: 未检测到系统浏览器或 Playwright Chromium（启动菜单可安装）');
  }
}

export async function installPlaywrightChromium(rootDir = process.cwd()) {
  const extraEnv = process.env.PLAYWRIGHT_DOWNLOAD_HOST === undefined
    ? PLAYWRIGHT_DOWNLOAD_ENV
    : {};
  await spawnCommand('pnpm', ['exec', 'playwright', 'install', 'chromium'], rootDir, extraEnv);
}

export class DependencyManager {
  constructor(logger) {
    this.logger = logger;
  }

  async parsePackageJson(packageJsonPath) {
    return JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
  }

  async installDependencies(missingDeps, cwd = process.cwd(), { resume = false } = {}) {
    const prefix = cwd !== process.cwd() ? `[${path.basename(cwd)}] ` : '';
    if (resume) {
      await this.logger.warning(`${prefix}上次依赖安装未完成（可能因 Ctrl+C 中断），重新执行 pnpm install...`);
    } else {
      await this.logger.warning(`${prefix}发现 ${missingDeps.length} 个缺失依赖，使用 pnpm 安装...`);
    }
    await spawnPnpmInstall(cwd);
    await markDepsInstallComplete(path.join(cwd, 'node_modules'));
    await this.logger.success(`${prefix}依赖安装完成`);
  }

  async checkAndInstall(packageJsonPath, nodeModulesPath) {
    const packageRoot = path.dirname(packageJsonPath);
    const pkg = await this.parsePackageJson(packageJsonPath);
    const depNames = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    if (depNames.length === 0) return;
    const missing = getMissingDependencies(depNames, nodeModulesPath, packageRoot);
    const complete = isDepsInstallComplete(nodeModulesPath);
    if (missing.length > 0) {
      await this.installDependencies(missing, packageRoot);
    } else if (!complete) {
      await this.installDependencies(depNames, packageRoot, { resume: true });
    }
  }

  _checkInstallSafe(packageJsonPath, nodeModulesPath, rootDir) {
    const label = path.relative(rootDir, path.dirname(packageJsonPath)) || packageJsonPath;
    return this.checkAndInstall(packageJsonPath, nodeModulesPath)
      .catch((e) => this.logger.warning(`${label}: ${e.message}`));
  }

  async ensurePluginDependencies(rootDir = process.cwd()) {
    const coreDirs = await paths.getCoreDirs();
    await Promise.all(coreDirs.map(async (dir) => {
      const pkgPath = path.join(dir, 'package.json');
      if (!statFiles([pkgPath])[0]) return;
      await this._checkInstallSafe(pkgPath, path.join(dir, 'node_modules'), rootDir);
    }));
  }

  async ensureFrontendDependencies(rootDir = process.cwd()) {
    const tasks = [];
    for (const coreDir of await paths.getCoreDirs()) {
      const coreName = path.basename(coreDir);
      const wwwDir = path.join(paths.coreSource, coreName, 'www');
      if (!statDirs([wwwDir])[0]) continue;

      const entries = await fs.readdir(wwwDir, { withFileTypes: true });
      const subDirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(wwwDir, e.name));

      for (const dir of [wwwDir, ...subDirs]) {
        const pkgPath = path.join(dir, 'package.json');
        const signPath = path.join(dir, 'sign.json');
        if (!statFiles([pkgPath, signPath]).every(Boolean)) continue;
        tasks.push(this._checkInstallSafe(pkgPath, path.join(dir, 'node_modules'), rootDir));
      }
    }
    await Promise.all(tasks);
  }
}
