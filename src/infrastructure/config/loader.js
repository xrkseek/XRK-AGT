import runtimeConfig from './config.js';
import chalk from 'chalk';
import setLog from '#infrastructure/log.js';
import { initDatabases, closeDatabases } from '#infrastructure/database/index.js';
import SystemMonitor from '#modules/systemmonitor.js';
import { normalizeError } from '#utils/normalize-error.js';
import {
  runShutdownHooks,
  handleDoubleTapSignal,
  SignalTapState,
  SERVER_SIGNALS,
  EXIT_RESTART,
  EXIT_STOP
} from '#utils/process-signals.js';
import { getRuntimeGlobal, isShuttingDown, setShuttingDown, isProcessFlagSet, setProcessFlag } from '#utils/runtime-globals.js';
import { isUvInterfaceAddressesError } from '#utils/safe-os-network.js';

const CONFIG = {
  PROCESS_TITLE: 'XRK-AGT',
  TIMEZONE: 'Asia/Shanghai'
};

/** 瞬时 socket 错误：只记日志，不拖垮进程（Redis/QQ 断线常见） */
const TRANSIENT_NETWORK_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME'];

let bootstrapPackagesPromise = null;

class ProcessManager {
  tap = new SignalTapState();
  _restarting = false;

  async updateTitle() {
    const currentQQ = global.selectedQQ ?? process.argv.find((arg) => /^\d+$/.test(arg));
    process.title = currentQQ === 'server' ? `${CONFIG.PROCESS_TITLE}@Server` : CONFIG.PROCESS_TITLE;
  }

  async restart() {
    if (isShuttingDown() || this._restarting) return;
    this._restarting = true;
    logger.mark(chalk.yellow('重启中...'));
    await this.cleanup();
    if (getRuntimeGlobal('AgentRuntime')) {
      await getRuntimeGlobal('AgentRuntime').closeServer({ fast: true }).catch(() => {});
    }
    process.exit(EXIT_RESTART);
  }

  isTransientNetworkError(error) {
    return TRANSIENT_NETWORK_CODES.includes(error.code);
  }

  async gracefulShutdown(exitCode) {
    if (isShuttingDown()) return;
    setShuttingDown(true);
    logger.mark(chalk.yellow('正在关闭...'));
    const bot = getRuntimeGlobal('AgentRuntime');
    if (bot) {
      await bot.closeServer().catch((err) => logger.error(`关闭失败: ${err.message}`));
    } else {
      await getRuntimeGlobal('logger')?.shutdown?.().catch(() => {});
    }
    await this.cleanup();
    process.exit(exitCode);
  }

  setupSignalHandlers() {
    if (isProcessFlagSet('__xrkSignalHandlersReady')) return;
    setProcessFlag('__xrkSignalHandlersReady', true);

    const handleSignal = async (signal) => {
      if (this._restarting || isShuttingDown()) return;

      await handleDoubleTapSignal(signal, this.tap, {
        onHangup: async () => {
          logger.mark(chalk.yellow('终端断开，正在关闭…'));
          await this.gracefulShutdown(EXIT_STOP);
        },
        onTwice: async (sig) => {
          logger.mark(chalk.yellow(`检测到连续两次 ${sig}，返回菜单`));
          await this.gracefulShutdown(EXIT_STOP);
        },
        onOnce: async (sig) => {
          logger.mark(chalk.yellow(`接收到 ${sig}，正在重启`));
          try {
            await this.restart();
          } catch (err) {
            logger.error(`restart 异常: ${err?.message || err}`);
            process.exit(EXIT_RESTART);
          }
        }
      });
    };

    for (const signal of SERVER_SIGNALS) {
      process.removeAllListeners(signal);
      process.on(signal, () => {
        void handleSignal(signal);
      });
    }
  }

  setupErrorHandlers() {
    if (isProcessFlagSet('__xrkErrorHandlersReady')) return;
    setProcessFlag('__xrkErrorHandlersReady', true);

    const onUnexpected = async (reason, label) => {
      if (isShuttingDown()) return;
      const error = normalizeError(reason);
      // 网卡枚举瞬态错误：忽略且不重启（见 #utils/safe-os-network）
      if (isUvInterfaceAddressesError(error)) {
        logger.warn(`${label}: 网卡枚举失败（已忽略）: ${error.message}`);
        return;
      }
      if (this.isTransientNetworkError(error)) {
        logger.warn(`${label}: ${error.message} (${error.code || 'no-code'}，不自动重启)`);
        return;
      }
      logger.error(`${label}: ${error.message}`);
    };

    process.on('uncaughtException', (error) => void onUnexpected(error, '未捕获异常'));
    process.on('unhandledRejection', (reason) => void onUnexpected(reason, '未处理Promise'));
    process.on('exit', (code) => {
      logger.mark(chalk.magenta(`XRK-AGT 已停止，退出码: ${code}`));
    });
  }

  async cleanup() {
    await runShutdownHooks();
    SystemMonitor.getInstance().stop();
    await closeDatabases().catch(() => {});
  }
}

class InitManager {
  processManager = new ProcessManager();
  systemMonitor = SystemMonitor.getInstance();

  setupEnvironment() {
    process.env.TZ = CONFIG.TIMEZONE;
    this.processManager.setupErrorHandlers();
    this.processManager.setupSignalHandlers();
  }

  /**
   * 启动 SystemMonitor；`critical` 时仅当规范化后 `autoRestart === true` 才重启。
   * @returns {Promise<void>}
   */
  async startMonitoring() {
    const monitorConfig = runtimeConfig.monitor;
    if (!monitorConfig.enabled) return;

    setTimeout(() => {
      this.systemMonitor.start(monitorConfig).catch((error) => {
        logger.error(`系统监控启动失败: ${error.message}`);
      });
    }, 100);

    this.systemMonitor.on('critical', ({ type }) => {
      logger.error(`系统资源严重不足: ${type}`);
      if (this.systemMonitor.config?.optimize?.autoRestart === true) {
        logger.error('将在5秒后重启...');
        setTimeout(() => this.processManager.restart(), 5000);
      }
    });
  }

  async init() {
    await setLog();
    runtimeConfig.warmupConfigs();
    logger.mark(chalk.cyan('XRK-AGT 初始化中...'));

    this.setupEnvironment();
    await initDatabases();
    await this.processManager.updateTitle();
    await this.startMonitoring();

    logger.mark(chalk.green('XRK-AGT 初始化完成'));
    return { success: true, mode: 'server' };
  }
}

export default async function bootstrapRuntimePackages() {
  if (!bootstrapPackagesPromise) {
    bootstrapPackagesPromise = new InitManager().init().catch((error) => {
      bootstrapPackagesPromise = null;
      throw error;
    });
  }
  return bootstrapPackagesPromise;
}
