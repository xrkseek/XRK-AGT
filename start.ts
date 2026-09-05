// @ts-nocheck
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { fixWindowsUTF8 } from '#utils/win-utf8.js';
import { createSimpleLogger } from '#utils/simple-logger.js';
import { getBrowserStatus, installPlaywrightChromium } from '#utils/bootstrap-deps.js';
import {
  MenuSignalHandler,
  resolveChildExit,
  killProcessTree,
  registerShutdownHook,
  EXIT_STOP,
  EXIT_RESTART,
} from '#utils/process-signals.js';
import { normalizeError } from '#utils/normalize-error.js';

fixWindowsUTF8();
process.setMaxListeners(30);

const entry = process.argv[1];
if (entry && path.basename(entry) === 'start.js') {
  const appPath = path.resolve(process.cwd(), 'app.js');
  const result = spawnSync(process.argv[0], [appPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  process.exit(result.status !== null ? result.status : 1);
}

let globalMenuSignalHandler = null;

async function cleanup() {
  if (!globalMenuSignalHandler) return;
  await globalMenuSignalHandler.cleanup();
  globalMenuSignalHandler = null;
}

const PATHS = {
  LOGS: './logs',
  DEFAULT_CONFIG: './config/default_config',
  SERVER_BOTS: './data/server_bots',
};
const PM2_TMP_PREFIX = path.join(os.tmpdir(), 'xrk-agt-pm2-');

/** 子进程 exit(0) 停止自动重启；exit(1) 表示重启 */
const CONFIG = {
  MAX_RESTARTS: 1000,
  PM2_LINES: 100,
  MEMORY_LIMIT: '512M',
  RESTART_DELAYS: {
    SHORT: 1000,
    MEDIUM: 5000,
    LONG: 15000,
  },
  EXIT_STOP,
  EXIT_RESTART,
};

const JSON_SPACE = 2;

function formatError(err) {
  const error = normalizeError(err);
  return error.stack || error.message;
}

/** @returns {number | null} */
function parsePort(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

async function writeFileIfChanged(filePath, content) {
  try {
    const existing = await fs.readFile(filePath, typeof content === 'string' ? 'utf8' : undefined);
    if (existing === content) return false;
  } catch (err) {
    if (Error.isError(err) && err.code !== 'ENOENT') throw err;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return true;
}

let _restartLogger = null;

function getLogger() {
  _restartLogger ??= createSimpleLogger(path.join(PATHS.LOGS, 'restart.log'), false);
  return _restartLogger;
}

class BaseManager {
  constructor(logger) {
    this.logger = logger;
  }
}

class PM2Manager extends BaseManager {
  getPM2Path() {
    const localPm2Path = process.platform === 'win32'
      ? path.join(process.cwd(), 'node_modules', 'pm2', 'bin', 'pm2.cmd')
      : path.join(process.cwd(), 'node_modules', 'pm2', 'bin', 'pm2');

    if (fsSync.existsSync(localPm2Path)) return localPm2Path;
    return 'pm2';
  }

  getProcessName(port) {
    return `XRK-MultiBot-Server-${port}`;
  }

  async executePM2Command(command, args = [], processName = '') {
    const pm2Path = this.getPM2Path();
    let cmdCommand = pm2Path;
    let cmdArgs = [command, ...args];

    // Windows 全局 PM2 走 cmd /c；本地路径直接执行
    if (process.platform === 'win32' && pm2Path === 'pm2') {
      cmdCommand = 'cmd';
      cmdArgs = ['/c', 'pm2', command, ...args];
    }

    await this.logger.log(`执行PM2命令: ${command} ${args.join(' ')}`);

    const result = spawnSync(cmdCommand, cmdArgs, {
      stdio: 'inherit',
      windowsHide: true,
      detached: false,
      shell: false,
    });

    const success = result.status === 0;
    if (success) {
      await this.logger.success(`PM2 ${command} ${processName} 成功`);
    } else {
      await this.logger.error(`PM2 ${command} ${processName} 失败，状态码: ${result.status}`);
    }
    return success;
  }

  async createConfig(port) {
    const processName = this.getProcessName(port);
    const nodeArgs = getNodeArgs();
    const pm2Config = {
      name: processName,
      script: './app.js',
      args: ['server', port.toString()],
      interpreter: 'node',
      node_args: nodeArgs.join(' '),
      cwd: './',
      exec_mode: 'fork',
      max_memory_restart: CONFIG.MEMORY_LIMIT,
      out_file: `./logs/pm2_server_out_${port}.log`,
      error_file: `./logs/pm2_server_error_${port}.log`,
      env: {
        NODE_ENV: 'production',
        XRK_SERVER_PORT: port.toString(),
      },
    };

    const pm2Dir = await fs.mkdtemp(PM2_TMP_PREFIX);
    const configPath = path.join(pm2Dir, `pm2_server_${port}.json`);
    const payload = JSON.stringify({ apps: [pm2Config] }, null, JSON_SPACE);
    await writeFileIfChanged(configPath, payload);

    const cleanup = async () => {
      try {
        await fs.rm(pm2Dir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup failures */
      }
    };

    return { configPath, cleanup };
  }

  async executePortCommand(action, port) {
    const processName = this.getProcessName(port);
    const commandMap = {
      start: async () => {
        const { configPath, cleanup } = await this.createConfig(port);
        const ok = await this.executePM2Command('start', [configPath], processName);
        await cleanup();
        return ok;
      },
      logs: () => this.executePM2Command('logs', [processName, '--lines', CONFIG.PM2_LINES.toString()], processName),
      stop: () => this.executePM2Command('stop', [processName], processName),
      restart: () => this.executePM2Command('restart', [processName], processName),
    };

    return commandMap[action]?.() || false;
  }
}

class ServerManager extends BaseManager {
  _activeChild = null;

  constructor(logger, pm2Manager) {
    super(logger);
    this.pm2Manager = pm2Manager;

    if (!globalMenuSignalHandler) {
      globalMenuSignalHandler = new MenuSignalHandler({
        log: (msg, level) => this.logger.log(msg, level),
        warning: (msg) => this.logger.warning(msg),
      });
    }
    this.signalHandler = globalMenuSignalHandler;
    this.signalHandler.onStopRestartLoop = () => this.stopActiveChild();
  }

  async stopActiveChild() {
    if (this._activeChild) {
      await killProcessTree(this._activeChild);
    }
  }

  getPortDir(port) {
    return path.join(PATHS.SERVER_BOTS, String(port));
  }

  async ensurePortConfig(port, silent = false) {
    const { seedPortConfigs } = await import('#infrastructure/config/config-seed.js');
    return seedPortConfigs(port, { silent, logger: this.logger });
  }

  async removePortConfig(port) {
    const portDir = this.getPortDir(port);

    try {
      await fs.rm(portDir, { recursive: true, force: true });
      await this.logger.warning(`端口 ${port} 的配置目录已删除`);
      return true;
    } catch (error) {
      await this.logger.error(`删除端口配置失败: ${formatError(error)}`);
      return false;
    }
  }

  async getAvailablePorts() {
    try {
      const files = await fs.readdir(PATHS.SERVER_BOTS);
      const ports = [];
      for (const file of files) {
        const port = parsePort(file);
        if (port != null) ports.push(port);
      }
      return ports.sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  async addNewPort() {
    const { port } = await inquirer.prompt([{
      type: 'input',
      name: 'port',
      message: chalk.bold('请输入新的服务器端口号:'),
      validate: (input) =>
        parsePort(input) != null
          ? true
          : chalk.red('请输入有效的端口号 (1-65535)'),
    }]);

    const portNum = parsePort(port);
    await this.ensurePortConfig(portNum);
    return portNum;
  }

  async startServerMode(port) {
    const skipConfigCheck = process.env.XRK_SKIP_CONFIG_CHECK === '1';

    if (!skipConfigCheck) {
      await this.logger.log(`启动葵子服务器，端口: ${port}`);
      await this.ensurePortConfig(port);
    }

    try {
      const { default: AgentRuntime } = await import('./src/agent-runtime.js');
      const { setRuntimeGlobal } = await import('#utils/runtime-globals.js');
      const runtime = new AgentRuntime();
      setRuntimeGlobal('AgentRuntime', runtime);
      await runtime.run({ port });
    } catch (error) {
      await this.logger.error(`服务器模式启动失败: ${formatError(error)}`);
      throw error;
    }
  }

  async startWithAutoRestart(port) {
    await this.ensurePortConfig(port);

    if (!this.signalHandler.isSetup) this.signalHandler.setup();
    this.signalHandler.inRestartLoop = true;
    let restartCount = 0;
    const startTime = Date.now();
    const unhookShutdown = registerShutdownHook(() => this.stopActiveChild());

    try {
      while (restartCount < CONFIG.MAX_RESTARTS) {
        if (restartCount > 0) {
          await this.logger.log(`重启进程 (尝试 ${restartCount + 1}/${CONFIG.MAX_RESTARTS})`);
        }

        const exitCode = await this.runServerProcess(port, restartCount > 0);

        if (exitCode === CONFIG.EXIT_STOP) {
          await this.logger.log('正常退出，返回菜单');
          return;
        }

        await this.logger.log(`进程异常退出，状态码: ${exitCode}`);
        const waitTime = this.calculateRestartDelay(Date.now() - startTime, restartCount);
        if (waitTime > 0) {
          await this.logger.warning(`将在 ${waitTime / 1000} 秒后重启`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
        restartCount++;
      }

      await this.logger.error(`达到最大重启次数 (${CONFIG.MAX_RESTARTS})，停止重启`);
    } finally {
      unhookShutdown();
      await this.stopActiveChild();
      this.signalHandler.inRestartLoop = false;
      this._activeChild = null;
    }
  }

  async runServerProcess(port, skipConfigCheck = false) {
    const nodeArgs = getNodeArgs();
    const entryScript = path.join(process.cwd(), 'app.js');
    const startArgs = [...nodeArgs, entryScript, 'server', port.toString()];
    const cleanEnv = {
      ...process.env,
      XRK_SERVER_PORT: port.toString(),
      XRK_SKIP_CONFIG_CHECK: skipConfigCheck ? '1' : '0',
      // 热重启同样走 app.js initialize：根/插件/前端依赖 + stale www build
      XRK_SKIP_FRONTEND_START: process.env.XRK_SKIP_FRONTEND_START || '0',
      XRK_FAST_START: process.env.XRK_FAST_START || '0'
    };

    return new Promise((resolve) => {
      this.signalHandler._closeReadline();
      const child = spawn(process.argv[0], startArgs, {
        stdio: 'inherit',
        windowsHide: true,
        env: cleanEnv,
        detached: false
      });
      this._activeChild = child;

      const finish = (code, signal) => {
        if (this._activeChild === child) this._activeChild = null;
        this.signalHandler._ensureReadline();
        resolve(resolveChildExit(code, signal));
      };

      child.on('exit', (code, signal) => finish(code, signal));

      child.on('error', (err) => {
        this.signalHandler._ensureReadline();
        void this.logger.error(`子进程启动失败: ${normalizeError(err).message}`);
        if (this._activeChild === child) this._activeChild = null;
        resolve(CONFIG.EXIT_RESTART);
      });
    });
  }

  calculateRestartDelay(runTime, restartCount) {
    if (runTime < 10000 && restartCount > 2) {
      return restartCount > 5 ? CONFIG.RESTART_DELAYS.LONG : CONFIG.RESTART_DELAYS.MEDIUM;
    }
    return CONFIG.RESTART_DELAYS.SHORT;
  }

  async stopServer(port) {
    await this.logger.log(`尝试停止端口 ${port} 的服务器`);
    
    try {
      const response = await fetch(`http://localhost:${port}/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000)
      });
      
      if (response.ok) {
        await this.logger.success('服务器停止请求已发送');
      } else {
        await this.logger.warning(`服务器响应异常: ${response.status}`);
      }
    } catch (error) {
      await this.logger.error(`停止请求失败: ${normalizeError(error).message}`);
    }
  }
}

class MenuManager {
  constructor(serverManager, pm2Manager) {
    this.serverManager = serverManager;
    this.pm2Manager = pm2Manager;
  }

  async run() {
    console.log(chalk.cyan.bold('\n╔═══════════════════════════════════════╗'));
    console.log(chalk.cyan.bold('║       葵子多端口服务器管理系统        ║'));
    console.log(chalk.cyan.bold('╚═══════════════════════════════════════╝\n'));
    
    let shouldExit = false;
    
    while (!shouldExit) {
      try {
        const selected = await this.showMainMenu();
        shouldExit = await this.handleMenuAction(selected);
      } catch (error) {
        if (error?.isTtyError) {
          console.error(chalk.red('无法在当前环境中渲染菜单'));
          break;
        }
        const errorMsg = formatError(error);
        console.error(chalk.red('\n菜单操作出错:'));
        console.error(chalk.red(errorMsg));
        await this.serverManager.logger.error(`菜单操作出错: ${errorMsg}`);
      }
    }
  }

  async showMainMenu() {
    const availablePorts = await this.serverManager.getAvailablePorts();
    const browser = await getBrowserStatus();
    const pwLabel = !browser.playwrightInstalled
      ? chalk.gray('Playwright 未安装')
      : browser.browserInstalled
        ? chalk.green('Playwright Chromium 已安装')
        : chalk.yellow('Playwright Chromium 未安装');

    if (browser.needsBrowserReminder) {
      console.log(chalk.yellow.bold('\n! 未检测到系统浏览器（Chrome / Chromium / Edge）'));
      console.log(chalk.yellow('  默认渲染器 Playwright 需要浏览器：请在下方菜单选择「Playwright 浏览器」安装 Chromium\n'));
    }

    const choices = [
      ...availablePorts.map(port => ({
        name: chalk.green(`> 启动服务器 (端口: ${port})`),
        value: { action: 'start_server', port },
        short: `启动端口 ${port}`
      })),
      {
        name: chalk.blue('+ 添加新端口'),
        value: { action: 'add_port' },
        short: '添加新端口'
      },
      {
        name: chalk.yellow('- 删除端口配置'),
        value: { action: 'delete_port_config' },
        short: '删除端口配置'
      },
      {
        name: chalk.cyan('* PM2管理'),
        value: { action: 'pm2_menu' },
        short: 'PM2管理'
      },
      {
        name: `${chalk.magenta('◎ Playwright 浏览器')} ${chalk.gray('[')}${pwLabel}${chalk.gray(']')}`,
        value: { action: 'playwright_browser' },
        short: 'Playwright 浏览器'
      },
      new inquirer.Separator(chalk.gray('─────────────────────────────')),
      { 
        name: chalk.red('X 退出'), 
        value: { action: 'exit' },
        short: '退出'
      }
    ];
    
    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: chalk.bold('请选择操作:'),
      choices,
      pageSize: Math.min(choices.length, 10)
    }]);
    
    return selected;
  }

  async handleMenuAction(selected) {
    switch (selected.action) {
      case 'start_server':
        await this.serverManager.startWithAutoRestart(selected.port);
        break;
        
      case 'add_port':
        await this.handleAddPort();
        break;

      case 'delete_port_config':
        await this.handleDeletePortConfig();
        break;
        
      case 'pm2_menu':
        await this.showPM2Menu();
        break;

      case 'playwright_browser':
        await this.showPlaywrightBrowserMenu();
        break;
        
      case 'exit':
        console.log(chalk.cyan.bold('\n╔═══════════════════════════════════════╗'));
        console.log(chalk.cyan.bold('║                再见！                 ║'));
        console.log(chalk.cyan.bold('╚═══════════════════════════════════════╝\n'));
        await cleanup();
        return true;
    }
    
    return false;
  }

  async handleAddPort() {
    const newPort = await this.serverManager.addNewPort();
    
    if (newPort) {
      console.log(chalk.green.bold(`+ 端口 ${newPort} 已添加`));
      
      const { startNow } = await inquirer.prompt([{
        type: 'confirm',
        name: 'startNow',
        message: chalk.bold(`是否立即启动端口 ${newPort} 的服务器?`),
        default: true
      }]);
      
      if (startNow) {
        await this.serverManager.startWithAutoRestart(newPort);
      }
    }
  }

  async handleDeletePortConfig() {
    const ports = await this.serverManager.getAvailablePorts();
    if (ports.length === 0) {
      console.log(chalk.yellow('! 没有可删除的端口配置'));
      return;
    }

    const port = await this.selectPort(ports, 'delete');
    if (!port) return;

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: chalk.bold.yellow(`确定删除端口 ${port} 的配置目录及相关PM2配置文件吗？`),
      default: false
    }]);

    if (confirm) {
      await this.serverManager.removePortConfig(port);
    }
  }

  async showPlaywrightBrowserMenu() {
    const status = await getBrowserStatus();

    console.log(chalk.cyan.bold('\n── Playwright 浏览器 ──'));
    if (status.systemBrowserPath) {
      console.log(chalk.green(`  系统浏览器: ${status.systemBrowserPath}`));
      console.log(chalk.gray('  （Puppeteer 等可选用；Playwright 默认仍使用下方自带 Chromium）'));
    } else {
      console.log(chalk.yellow('  系统浏览器: 未检测到'));
      console.log(chalk.gray('  可安装系统 Chrome/Chromium（推荐，已自动使用），或在本菜单从 cdn.playwright.dev 下载自带包'));
    }
    if (!status.playwrightInstalled) {
      console.log(chalk.yellow('\n  npm 包 playwright 未安装，请先完成 pnpm install'));
    } else if (status.browserInstalled) {
      console.log(chalk.green('\n  Playwright Chromium: 已安装'));
      if (status.executablePath) {
        console.log(chalk.gray(`  路径: ${status.executablePath}`));
      }
    } else {
      console.log(chalk.yellow('\n  Playwright Chromium: 未安装（截图 / browser 工作流需要）'));
    }
    console.log('');

    if (!status.playwrightInstalled) {
      await inquirer.prompt([{
        type: 'input',
        name: 'back',
        message: chalk.gray('按 Enter 返回主菜单')
      }]);
      return;
    }

    const choices = [];
    if (!status.browserInstalled) {
      choices.push({
        name: chalk.green('> 安装 Chromium'),
        value: 'install',
        short: '安装 Chromium'
      });
    } else {
      choices.push({
        name: chalk.cyan('* 重新安装 Chromium'),
        value: 'reinstall',
        short: '重新安装'
      });
    }
    choices.push(
      new inquirer.Separator(chalk.gray('─────────────────────────────')),
      { name: chalk.gray('< 返回主菜单'), value: 'back', short: '返回' }
    );

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: chalk.bold('请选择:'),
      choices,
      pageSize: 10
    }]);

    if (action === 'back') return;

    if (action === 'reinstall') {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: chalk.bold.yellow('确定重新下载 Chromium？'),
        default: false
      }]);
      if (!confirm) return;
    }

    console.log(chalk.cyan('\n正在从 cdn.playwright.dev 下载 Playwright Chromium...\n'));
    try {
      await installPlaywrightChromium();
      console.log(chalk.green('\n✓ Playwright Chromium 安装完成\n'));
    } catch (err) {
      console.error(chalk.red(`\n✗ 安装失败: ${normalizeError(err).message}\n`));
      await this.serverManager.logger.error(`Playwright 浏览器安装失败: ${formatError(err)}`);
    }
  }

  async showPM2Menu() {
    const availablePorts = await this.serverManager.getAvailablePorts();
    
    if (availablePorts.length === 0) {
      console.log(chalk.yellow('! 没有可用的服务器端口'));
      return;
    }
    
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: chalk.bold('PM2管理:'),
      choices: [
        { name: chalk.green('> 启动服务器'), value: 'start', short: '启动服务器' },
        { name: chalk.blue('? 查看日志'), value: 'logs', short: '查看日志' },
        { name: chalk.yellow('- 停止进程'), value: 'stop', short: '停止进程' },
        { name: chalk.cyan('* 重启进程'), value: 'restart', short: '重启进程' },
        new inquirer.Separator(chalk.gray('─────────────────────────────')),
        { name: chalk.gray('< 返回主菜单'), value: 'back', short: '返回主菜单' }
      ],
      pageSize: 10
    }]);
    
    if (action === 'back') return;
    
    const port = await this.selectPort(availablePorts, action);
    if (port) {
      await this.pm2Manager.executePortCommand(action, port);
    }
  }

  async selectPort(availablePorts, action) {
    const actionMessages = {
      start: '选择要启动的端口:',
      logs: '查看哪个端口的日志?',
      stop: '停止哪个端口?',
      restart: '重启哪个端口?',
      delete: '选择要删除配置的端口:'
    };
    
    const choices = availablePorts.map(port => ({
      name: chalk.cyan(`端口 ${port}`),
      value: port,
      short: `端口 ${port}`
    }));
    
    if (action === 'start') {
      choices.push({ 
        name: chalk.blue('+ 添加新端口'), 
        value: 'add',
        short: '添加新端口'
      });
    }
    
    const { port } = await inquirer.prompt([{
      type: 'list',
      name: 'port',
      message: chalk.bold(actionMessages[action] || '请选择端口:'),
      choices,
      pageSize: Math.min(choices.length, 10)
    }]);
    
    if (port === 'add') {
      return await this.serverManager.addNewPort();
    }
    
    return port;
  }
}

function getNodeArgs() {
  const nodeArgs = [...process.execArgv];
  if (!nodeArgs.includes('--expose-gc')) nodeArgs.push('--expose-gc');
  if (!nodeArgs.includes('--no-warnings')) nodeArgs.push('--no-warnings');
  return nodeArgs;
}

if (process.env.XRK_FROM_APP !== '1') {
  process.on('uncaughtException', async (error) => {
    const logger = getLogger();
    const errorMsg = formatError(error);
    console.error('\n未捕获的异常:');
    console.error(errorMsg);
    await logger.error(`未捕获的异常: ${errorMsg}`);
    await cleanup();
    process.exit(1);
  });

  process.on('exit', () => {
    void cleanup();
  });
}

async function main() {
  const logger = getLogger();
  const commandArg = process.argv[2];
  const port = parsePort(process.argv[3] || process.env.XRK_SERVER_PORT);

  if (commandArg === 'server' && port) {
    const serverManager = new ServerManager(logger, null);
    await serverManager.startServerMode(port);
    return;
  }

  if (commandArg === 'stop' && port) {
    const serverManager = new ServerManager(logger, null);
    await serverManager.stopServer(port);
    return;
  }

  if (process.env.DOCKER_CONTAINER === '1' || !process.stdout.isTTY) {
    const defaultPort = parsePort(process.env.XRK_SERVER_PORT) ?? 8080;
    const serverManager = new ServerManager(logger, null);
    await serverManager.startServerMode(defaultPort);
    return;
  }

  const pm2Manager = new PM2Manager(logger);
  const serverManager = new ServerManager(logger, pm2Manager);
  const menuManager = new MenuManager(serverManager, pm2Manager);

  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H');
  }

  await menuManager.run();
  await cleanup();
}

export default main;

main().catch(async (error) => {
  const logger = getLogger();
  await logger.error(`启动失败: ${formatError(error)}`);
  await cleanup();
  process.exit(1);
});
