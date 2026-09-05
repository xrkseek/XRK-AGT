import fs from 'node:fs/promises';
import path from 'node:path';
import paths from '#utils/paths.js';
import { statDirs } from '#utils/core-fs.js';
import { createSimpleLogger } from '#utils/simple-logger.js';
import {
  DependencyManager,
  getPnpmInstallHint,
  logBrowserEnvironment,
} from '#utils/bootstrap-deps.js';

async function validateEnvironment(): Promise<void> {
  const [major] = process.version.slice(1).split('.').map(Number);
  if ((major ?? 0) < 26) {
    throw new Error(`Node.js 需 >= v26.0.0，当前: ${process.version}`);
  }
  await paths.ensureBaseDirs();
  // 先种子默认工作区 core/，再 warmup，PluginLoader 才能扫到工作区插件
  const { resolveAgentWorkspaceAbs } = await import('#utils/agent-workspace-paths.js');
  resolveAgentWorkspaceAbs();
  await paths.warmupCoreLayout();
}

async function loadDynamicImports(
  dependencyManager: DependencyManager,
  packageJsonPath: string,
): Promise<void> {
  const importsDir = path.join(process.cwd(), 'data', 'importsJson');
  if (!statDirs([importsDir])[0]) return;

  const files = (await fs.readdir(importsDir)).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return;

  const merged = Object.assign(
    {},
    ...(await Promise.all(
      files.map(async (f) => {
        const data = JSON.parse(await fs.readFile(path.join(importsDir, f), 'utf-8')) as {
          imports?: Record<string, string>;
        };
        return data.imports ?? {};
      }),
    )),
  ) as Record<string, string>;
  if (Object.keys(merged).length === 0) return;

  const pkg = (await dependencyManager.parsePackageJson(packageJsonPath)) as {
    imports?: Record<string, string>;
  };
  const nextImports = { ...pkg.imports, ...merged };
  if (JSON.stringify(pkg.imports) === JSON.stringify(nextImports)) return;
  pkg.imports = nextImports;
  await fs.writeFile(packageJsonPath, JSON.stringify(pkg, null, 2));
}

export class Bootstrap {
  logger: ReturnType<typeof createSimpleLogger>;
  dependencyManager: DependencyManager;

  constructor() {
    this.logger = createSimpleLogger(path.join('./logs', 'bootstrap.log'));
    this.dependencyManager = new DependencyManager(this.logger);
  }

  async initialize(): Promise<void> {
    await validateEnvironment();
    const root = process.cwd();
    const rootPkg = path.join(root, 'package.json');
    await Promise.all([
      this.dependencyManager.checkAndInstall(rootPkg, path.join(root, 'node_modules')),
      this.dependencyManager.ensurePluginDependencies(root),
    ]);
    if (process.env.XRK_SKIP_FRONTEND_BOOTSTRAP !== '1') {
      await this.dependencyManager.ensureFrontendDependencies(root);
    }
    if (process.env.XRK_SKIP_WWW_BUILD !== '1') {
      const { buildSignedStaticWwwBeforeRuntime } = await import(
        '#infrastructure/http/www-static-build.js'
      );
      const r = (await buildSignedStaticWwwBeforeRuntime({
        log: (level: string, msg: string) => {
          if (level === 'error') return this.logger.error(msg);
          if (level === 'warn') return this.logger.warning(msg);
          return this.logger.info(msg);
        },
      })) as { failed?: string[] };
      if (r.failed?.length) {
        await this.logger.warning(
          `启动过程前端构建失败: ${r.failed.join(', ')}（将尝试挂已有 dist；可手动 pnpm run build:www）`,
        );
      }
    }
    await loadDynamicImports(this.dependencyManager, rootPkg);
    await logBrowserEnvironment(this.logger, root);
  }

  async run(): Promise<void> {
    try {
      // 菜单：轻量环境校验；server（含热重启）：始终查依赖
      const isServer = process.argv[2] === 'server';
      if (isServer) {
        await this.initialize();
      } else {
        await validateEnvironment();
      }
      process.env.XRK_FROM_APP = '1';
      await new Promise((r) => setImmediate(r));
      await import('../../start.js');
    } catch (e) {
      const err = e as Error;
      await this.logger.error(`引导失败: ${err.stack ?? err.message}`);
      await this.logger.log(`\n可尝试: ${getPnpmInstallHint()}`);
      process.exit(1);
    }
  }
}
