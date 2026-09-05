import path from 'path';
import { spawn } from 'child_process';
import RuntimeUtil from '#utils/runtime-util.js';
import paths from '#utils/paths.js';
import runtimeConfig from '#infrastructure/config/config.js';
import { execFile } from '#utils/exec-async.js';
import { resolveCommandSpawn } from '#utils/command-spawn.js';
import { shouldProxyFrontend, resolveWwwPublicMountPath } from '#infrastructure/http/www-app-resolve.js';

/**
 * FrontendLauncher
 *
 * 只处理前端工程的「② 启进程 + 反代」（enabled=true / serve=proxy）。
 * 「① 只 build 不启动」由 mountCoreWwwStatic + www-static-build 完成。
 * 见 docs/www-mount.md。
 */
class FrontendLauncher {
  /** @type {Map<string, { config: any, process?: import('child_process').ChildProcess, status: string, restarts: number, startedAt?: number }>} */
  static #apps = new Map();

  static #discovered = false;
  static #discovering: any = null;
  static #started = false;
  static #starting: any = null;

  /** 子进程 stdout/stderr 中可忽略的进度行 */
  static #OUTPUT_NOISE = /^(?:>|$|vite v[\d.]+\s+building|transforming\.{3}|rendering chunks\.{3}|computing gzip size\.{3}|dist\/|✓ \d+ modules transformed|\(\!\)\s+Some chunks|- Using dynamic import|- Use build\.rollupOptions|- Adjust chunk size limit)/i;

  /** 值得打到主日志的关键行 */
  static #OUTPUT_KEY = /(?:Local:|Network:|ready in|built in|✓ built|error|Error|failed|EADDRINUSE|Port \d+ is in use|trying another one|➜)/i;

  static #LOCAL_URL = /(?:Local:|Network:)\s*(https?:\/\/\S+)/i;

  /** AgentRuntime 代理读取实际监听端口（Vite 端口漂移时） */
  static getRuntimePort(id: any) {
    const app = this.#apps.get(id);
    return app?.runtimePort ?? app?.config?.port;
  }

  /**
   * 仅扫描 sign.json 并注册元数据，不启动 dev server
   */
  static async discover() {
    if (this.#discovered) return this.#apps;
    if (this.#discovering) return this.#discovering;

    this.#discovering = this.#doDiscover()
      .catch(err => {
        RuntimeUtil.makeLog('error', `前端项目扫描失败: ${err.message}`, 'Frontend');
        return this.#apps;
      })
      .finally(() => {
        this.#discovered = true;
        this.#discovering = null;
      });

    return this.#discovering;
  }

  /**
   * 启动已发现的前端 dev server（需先 discover）
   */
  static async start() {
    if (process.env.XRK_SKIP_FRONTEND_START === '1') {
      await this.discover();
      RuntimeUtil.makeLog('info', 'XRK_SKIP_FRONTEND_START=1，跳过前端 dev server 启动', 'Frontend');
      return this.#apps;
    }

    await this.discover();
    if (this.#started) return this.#apps;
    if (this.#starting) return this.#starting;

    this.#starting = this.#doStart()
      .catch(err => {
        RuntimeUtil.makeLog('error', `前端项目启动失败: ${err.message}`, 'Frontend');
        return this.#apps;
      })
      .finally(() => {
        this.#started = true;
        this.#starting = null;
      });

    return this.#starting;
  }

  static #spawnChildProcess(cmd: any, args: any, { cwd, env }: any) {
    // Windows 下 `pnpm`/`npm` 常为 .cmd，裸 spawn 会 ENOENT；统一走 command-spawn
    const spawnSpec = resolveCommandSpawn(cmd, args, cwd);
    return spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: spawnSpec.shell,
      windowsHide: true,
    });
  }

  static #attachProcessOutput(child: any, appInfo: any) {
    const appId = appInfo.config.id;
    let pending = '';
    const flushLine = (raw: any) => {
      const line = raw.replace(/\r$/, '').trim();
      if (!line || this.#OUTPUT_NOISE.test(line)) return;

      const localMatch = line.match(this.#LOCAL_URL);
      if (localMatch) {
        try {
          const u = new URL(localMatch[1]);
          const p = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
          appInfo.runtimePort = p;
          appInfo.status = 'running';
          RuntimeUtil.makeLog('info', `[${appId}] 监听 ${u.href}`, 'Frontend');
          return;
        } catch {}
      }

      const verbose = process.env.XRK_FRONTEND_VERBOSE === '1';
      if (!verbose && !this.#OUTPUT_KEY.test(line)) return;

      const level = /error|failed|EADDRINUSE/i.test(line) ? 'warn' : 'info';
      RuntimeUtil.makeLog(verbose ? 'debug' : level, `[${appId}] ${line}`, 'Frontend');
    };

    const onChunk = (chunk: any) => {
      pending += chunk?.toString?.() ?? '';
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) flushLine(line);
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
  }

  static #wireChild(child: any, appInfo: any, config: any) {
    this.#attachProcessOutput(child, appInfo);
    child.on('error', (err: any) => {
      appInfo.status = 'error';
      RuntimeUtil.makeLog('error', `前端项目进程错误: ${config.id} - ${err.message}`, 'Frontend');
    });
  }

  static async #killChildTree(child: any) {
    if (!child?.pid || child.killed) return;
    try {
      if (process.platform === 'win32') {
        await execFile('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
        return;
      }
      child.kill('SIGTERM');
    } catch {}
  }

  /** Vite dev/preview 追加 strictPort，避免端口漂移导致代理失效 */
  static #viteRuntimeArgs(args: any, port: any) {
    const list = [...(args || [])];
    if (!list.some((a) => /^(dev|preview|serve)$/i.test(String(a)))) return list;
    if (list.some((a) => String(a).includes('strictPort'))) return list;
    return [...list, '--', '--strictPort', '--host', '127.0.0.1', '--port', String(port)];
  }

  /**
   * @param {number} port
   * @param {{ force?: boolean }} [opts] force=true 时才强杀占用进程；默认只检测并抛错
   */
  static async #ensurePortFree(port: any, opts: any = {}) {
    if (!Number.isFinite(port) || port <= 0) return;
    const killPids = new Set();
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execFile('netstat', ['-ano'], { encoding: 'utf8' });
        const suffix = `:${port}`;
        for (const line of stdout.split(/\r?\n/)) {
          if (!/LISTENING/i.test(line)) continue;
          const parts = line.trim().split(/\s+/);
          const local = parts[1] || '';
          if (!local.endsWith(suffix)) continue;
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid) && pid !== '0') killPids.add(pid);
        }
      } else {
        const { stdout } = await execFile('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).catch(() => ({ stdout: '' }));
        for (const pid of stdout.trim().split(/\s+/)) {
          if (pid) killPids.add(pid);
        }
      }
    } catch {
      /* ignore probe errors */
    }

    const self = String(process.pid);
    const foreign = [...killPids].filter((pid: any) => pid !== self);
    if (!foreign.length) return;

    if (!opts.force) {
      throw new Error(
        `端口 ${port} 已被占用 (PID: ${foreign.join(', ')})；请结束占用进程，或在 sign.json 设 "forceFreePort": true`,
      );
    }

    for (const pid of foreign) {
      if (process.platform === 'win32') {
        await execFile('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {});
      } else {
        await execFile('kill', ['-9', String(pid)]).catch(() => {});
      }
    }
    await RuntimeUtil.sleep(400).catch(() => {});
    RuntimeUtil.makeLog('warn', `已强制释放端口 ${port} (PID: ${foreign.join(', ')})`, 'Frontend');
  }

  /** 停止所有已启动的前端子进程（用于主服务关闭/重启释放资源） */
  static async stopAll() {
    const apps = Array.from(this.#apps.values());
    for (const app of apps) {
      if (!app) continue;
      app.stopping = true;
      if (app.restartTimer) {
        clearTimeout(app.restartTimer);
        app.restartTimer = undefined;
      }
      for (const child of [app.process, app.buildProcess]) {
        if (child && !child.killed) await this.#killChildTree(child);
      }
    }

    await RuntimeUtil.sleep(800).catch(() => {});

    for (const app of apps) {
      if (!app) continue;
      app.process = undefined;
      app.buildProcess = undefined;
      app.status = 'stopped';
      app.startedAt = undefined;
      if (app.config?.port) {
        await this.#ensurePortFree(app.config.port, { force: true }).catch(() => {});
      }
    }

    this.#started = false;
  }

  static #getAppMode(json: any) {
    const raw = json?.mode ? String(json.mode).toLowerCase() : 'auto';
    if (raw === 'dev' || raw === 'prod' || raw === 'auto') return raw;
    return 'auto';
  }

  static #normalizeCommandSpec(spec: any, fallbackCwd: any) {
    if (!spec || typeof spec !== 'object') return null;
    const command = spec.command && String(spec.command).trim();
    if (!command) return null;
    const args = Array.isArray(spec.args) ? spec.args.map((a: any) => String(a)) : [];
    const cwd = spec.cwd ? path.resolve(paths.root, String(spec.cwd)) : fallbackCwd;
    const env = (spec.env && typeof spec.env === 'object') ? spec.env : {};
    return { command, args, cwd, env };
  }

  /**
   * 扫描 sign.json 并注册元数据
   * @private
   */
  static async #doDiscover() {
    const startTime = Date.now();
    const configs = await this.#discoverConfigs();

    if (configs.length === 0) {
      RuntimeUtil.makeLog('info', '未发现启用的 sign.json 前端项目', 'Frontend');
      return this.#apps;
    }

    for (const cfgApp of configs) {
      this.#registerApp(cfgApp);
    }

    const used = RuntimeUtil.getTimeDiff(startTime);
    RuntimeUtil.makeLog(
      'info',
      `前端项目扫描完成: ${this.#apps.size} 个, 耗时 ${used}`,
      'Frontend'
    );

    return this.#apps;
  }

  /**
   * 启动已注册的前端 dev server
   * @private
   */
  static async #doStart() {
    const startTime = Date.now();
    const pending = Array.from(this.#apps.values()).filter(
      app => app && (app.status === 'queued' || app.status === 'stopped')
    );

    if (pending.length === 0) {
      return this.#apps;
    }

    RuntimeUtil.makeLog('info', `开始启动前端项目 ${pending.length} 个...`, 'Frontend');

    for (const appInfo of pending) {
      this.#startApp(appInfo.config);
    }

    const used = RuntimeUtil.getTimeDiff(startTime);
    RuntimeUtil.makeLog(
      'info',
      `前端项目启动完成: ${this.#apps.size} 个, 耗时 ${used}`,
      'Frontend'
    );

    return this.#apps;
  }

  /**
   * 扫描所有 core/*-Core/www 下的 sign.json
   * @private
   * @returns {Promise<Array<object>>}
   */
  static async #discoverConfigs() {
    const pattern = path.posix.join('core', '*-Core', 'www', '**', 'sign.json');
    const files = await RuntimeUtil.glob(pattern, {
      absolute: true,
      ignore: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/out/**'
      ]
    });

    if (!files || files.length === 0) {
      return [];
    }

    const configs = [];

    for (const file of files) {
      try {
        const raw = await RuntimeUtil.readFile(file, 'utf8');
        const json = JSON.parse(raw);

        // 与 mount-core-www 同一套决策：static / enabled:false 不拉进程
        if (!shouldProxyFrontend(json)) {
          RuntimeUtil.makeLog('debug', `跳过静态模式前端 sign.json: ${file}`, 'Frontend');
          continue;
        }

        const mode = this.#getAppMode(json);
        const isProd = mode === 'prod' || (mode === 'auto' && json && (json.prod || json.build));
        if (json && json.devOnly === true && isProd) {
          RuntimeUtil.makeLog('info', `跳过 devOnly 前端工程（生产模式不启动）: ${file}`, 'Frontend');
          continue;
        }
        if (json && Array.isArray(json.modes) && json.modes.length > 0) {
          const modes = json.modes.map((m: any) => String(m).toLowerCase());
          const required = isProd ? 'prod' : 'dev';
          if (!modes.includes(required)) {
            RuntimeUtil.makeLog('info', `跳过 modes 不匹配的前端工程(${required}): ${file}`, 'Frontend');
            continue;
          }
        }

        const dir = path.dirname(file);
        const relFromCore = path
          .relative(paths.coreSource, dir)
          .replace(/\\/g, '/');

        const coreName = relFromCore.split('/')[0] || '';
        const id = String(json.id || path.basename(dir));

        const port = Number(json.port);
        const defaultCommand = json.command && String(json.command).trim();

        // 生产环境可选：使用 prod 段覆盖 command/args/port（dev 仍用顶层）
        const prodSpec = this.#normalizeCommandSpec(json.prod, dir);
        const devSpec = this.#normalizeCommandSpec({ command: defaultCommand, args: json.args }, dir);
        const runSpec = isProd && prodSpec ? prodSpec : devSpec;

        // 可选：生产环境启动前 build
        const buildSpec = this.#normalizeCommandSpec(json.build, dir);
        const buildOnStart = json.buildOnStart !== false; // 默认 true（当提供 build 段时）

        if (!runSpec || !Number.isFinite(port) || port <= 0) {
          RuntimeUtil.makeLog(
            'warn',
            `sign.json 缺少必要字段(${isProd ? 'command/port 或 prod.command/port' : 'command/port'}): ${file}`,
            'Frontend'
          );
          continue;
        }

        const cwd = json.cwd
          ? path.resolve(paths.root, json.cwd)
          : dir;

        const publicPath = (json.publicPath && String(json.publicPath).trim()) ||
          (coreName
            ? `/core/${coreName}/${id}`
            : `/${id}`);

        const mountPath = resolveWwwPublicMountPath(path.basename(dir), json);
        const env = (json.env && typeof json.env === 'object')
          ? json.env
          : {};

        const autoRestart = json.autoRestart !== false;

        const config = {
          id,
          name: json.name || id,
          description: json.description || '',
          coreName,
          signFile: file,
          mode,
          cwd,
          command: runSpec.command,
          args: runSpec.args,
          port,
          publicPath,
          // 开发入口挂载路径（由 sign.json 决定）
          mountPath,
          env,
          autoRestart,
          forceFreePort: json.forceFreePort === true,
          // 生产环境可选：build + prod 启动声明（不影响开发态）
          build: buildSpec ? { ...buildSpec, env: { ...env, ...buildSpec.env } } : null,
          buildOnStart,
          prod: prodSpec ? { ...prodSpec, env: { ...env, ...prodSpec.env } } : null
        };

        configs.push(config);
      } catch (err: any) {
        RuntimeUtil.makeLog(
          'warn',
          `解析 sign.json 失败: ${file} - ${err.message}`,
          'Frontend'
        );
      }
    }

    return configs;
  }

  /**
   * 启动单个前端项目
   * @private
   * @param {object} config
   */
  static #registerApp(config: any) {
    if (this.#apps.has(config.id)) return;
    this.#apps.set(config.id, {
      config,
      process: undefined,
      status: 'queued',
      restarts: 0,
      runtimePort: config.port,
      startedAt: Date.now()
    });
  }

  static #startApp(config: any) {
    const appInfo = this.#apps.get(config.id);
    if (!appInfo) return;

    // 主服务信息，用于透传给前端（通过 Vite 的 import.meta.env 访问）
    const mainPort = runtimeConfig.port || 8086;
    const mainOrigin = runtimeConfig.server?.server?.url || `http://127.0.0.1:${mainPort}`;

    const childEnv = {
      ...process.env,
      ...config.env,
      PORT: String(config.port),
      // 提供给 React / Vite 的运行时环境变量（仅 VITE_* 会暴露到浏览器）
      VITE_XRK_MAIN_ORIGIN: mainOrigin,
      // 公开前端可感知的挂载路径（由 sign.json 的 proxy.mount 或 id 决定）
      VITE_XRK_PUBLIC_PATH: config.mountPath || config.publicPath || '/',
      VITE_XRK_CORE_NAME: config.coreName || '',
      VITE_XRK_APP_ID: config.id
    };

    const isProd = config.mode === 'prod' || (config.mode === 'auto' && (config.prod || config.build));
    const runCmd = (isProd && config.prod?.command) ? config.prod.command : config.command;
    const runArgs = (isProd && Array.isArray(config.prod?.args)) ? config.prod.args : (config.args || []);
    const runCwd = (isProd && config.prod?.cwd) ? config.prod.cwd : config.cwd;
    const runEnv = (isProd && config.prod?.env) ? { ...childEnv, ...config.prod.env } : childEnv;

    const buildCmd = isProd && config.build?.command ? config.build.command : null;
    const buildArgs = isProd && Array.isArray(config.build?.args) ? config.build.args : [];
    const buildCwd = isProd && config.build?.cwd ? config.build.cwd : config.cwd;
    const buildEnv = isProd && config.build?.env ? { ...childEnv, ...config.build.env } : childEnv;
    const shouldBuild = Boolean(buildCmd) && config.buildOnStart !== false;

    const baseInfo = `${config.id} (${runCmd} ${runArgs.join(' ')}) @ ${runCwd}`;
    const targetUrl = `http://127.0.0.1:${config.port}`;

    RuntimeUtil.makeLog(
      'info',
      `启动前端项目: ${baseInfo} -> ${targetUrl}${config.publicPath}`,
      'Frontend'
    );

    const spawnChild = (cmd: any, args: any, cwd: any, env: any) =>
      this.#spawnChildProcess(cmd, args, { cwd, env });

    const startRuntime = async () => {
      try {
        await this.#ensurePortFree(config.port, { force: config.forceFreePort === true });
      } catch (err: any) {
        appInfo.status = 'error';
        RuntimeUtil.makeLog(
          'error',
          `前端项目无法启动: ${config.id} — ${err?.message || err}`,
          'Frontend',
        );
        return;
      }
      appInfo.runtimePort = config.port;
      appInfo.status = 'starting';
      const runtimeArgs = this.#viteRuntimeArgs(runArgs, config.port);
      const child = spawnChild(runCmd, runtimeArgs, runCwd, runEnv);
      appInfo.process = child;
      this.#wireChild(child, appInfo, config);

      child.on('exit', (code: any, signal: any) => {
        appInfo.status = 'stopped';
        appInfo.process = undefined;
        const reason = code !== null ? `退出码=${code}` : `信号=${signal || 'unknown'}`;
        if (appInfo.stopping) {
          RuntimeUtil.makeLog('debug', `前端项目已停止: ${config.id} (${reason})`, 'Frontend');
          return;
        }
        RuntimeUtil.makeLog(code === 0 ? 'info' : 'warn', `前端项目已退出: ${config.id} (${reason})`, 'Frontend');

        if (!config.autoRestart) return;
        if (appInfo.restarts >= 3) {
          RuntimeUtil.makeLog('warn', `前端项目重启次数已达上限，停止重启: ${config.id}`, 'Frontend');
          return;
        }

        appInfo.restarts += 1;
        const delay = 1000 * appInfo.restarts;
        RuntimeUtil.makeLog('info', `准备重启前端项目(${appInfo.restarts}): ${config.id}, ${delay}ms 后`, 'Frontend');
        if (appInfo.restartTimer) clearTimeout(appInfo.restartTimer);
        appInfo.restartTimer = setTimeout(() => { void startRuntime(); }, delay);
        appInfo.restartTimer.unref?.();
      });
    };

    if (shouldBuild) {
      appInfo.status = 'building';
      RuntimeUtil.makeLog('info', `生产环境后台构建前端: ${config.id} (${buildCmd} ${buildArgs.join(' ')})`, 'Frontend');
      const buildChild = spawnChild(buildCmd, buildArgs, buildCwd, buildEnv);
      appInfo.buildProcess = buildChild;
      this.#wireChild(buildChild, appInfo, config);
      buildChild.on('exit', (code: any) => {
        appInfo.buildProcess = undefined;
        if (code !== 0) {
          appInfo.status = 'error';
          RuntimeUtil.makeLog('error', `前端构建失败，跳过启动: ${config.id} (退出码=${code})`, 'Frontend');
          return;
        }
        RuntimeUtil.makeLog('info', `前端构建完成，准备启动: ${config.id}`, 'Frontend');
        void startRuntime();
      });
      return;
    }

    void startRuntime();
  }
}

export default FrontendLauncher;

