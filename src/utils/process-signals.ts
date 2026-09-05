import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/** 连按两次退出的判定窗口（毫秒） */
export const SIGNAL_TIME_THRESHOLD_MS = 3000;

export const EXIT_RESTART = 1;
export const EXIT_STOP = 0;

export const SERVER_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

const STOP_EXIT_CODES = new Set([EXIT_STOP, 130, 143, 255]);

const shutdownHooks = new Set<() => void | Promise<void>>();

export function registerShutdownHook(fn: () => void | Promise<void>): () => void {
  shutdownHooks.add(fn);
  return () => {
    shutdownHooks.delete(fn);
  };
}

export async function runShutdownHooks(): Promise<void> {
  await Promise.allSettled([...shutdownHooks].map((fn) => fn()));
}

/** 子进程 exit(1) → 父进程自动重启；exit(0)/130/143 → 回菜单 */
export function resolveChildExit(code: number | null | undefined, signal: NodeJS.Signals | null | undefined): number {
  if (code === EXIT_RESTART) return EXIT_RESTART;
  if (typeof code === 'number' && STOP_EXIT_CODES.has(code)) return EXIT_STOP;
  if (signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP') return EXIT_STOP;
  if (code == null && signal) return EXIT_STOP;
  if (typeof code === 'number' && code !== 0) return EXIT_RESTART;
  return EXIT_STOP;
}

export async function killProcessTree(child: ChildProcess | null | undefined): Promise<void> {
  if (!child?.pid || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
      });
      return;
    }
    spawnSync('pkill', ['-TERM', '-P', String(child.pid)], { stdio: 'ignore' });
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    spawnSync('pkill', ['-KILL', '-P', String(child.pid)], { stdio: 'ignore' });
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

/** 双击判定状态（ProcessManager / MenuSignalHandler 共用） */
export class SignalTapState {
  lastSignal: string | null = null;
  lastSignalTime = 0;

  reset(): void {
    this.lastSignal = null;
    this.lastSignalTime = 0;
  }

  isDoubleTap(signal: string, now: number = Date.now()): boolean {
    return (
      signal !== 'SIGHUP' &&
      signal === this.lastSignal &&
      now - this.lastSignalTime < SIGNAL_TIME_THRESHOLD_MS
    );
  }

  record(signal: string, now: number = Date.now()): void {
    this.lastSignal = signal;
    this.lastSignalTime = now;
  }
}

type DoubleTapCallbacks = {
  onOnce?: (signal: string) => void | Promise<void>;
  onTwice?: (signal: string) => void | Promise<void>;
  onHangup?: () => void | Promise<void>;
};

/**
 * 统一规则：一次 onOnce，两次 onTwice，SIGHUP onHangup。
 */
export async function handleDoubleTapSignal(
  signal: string,
  state: SignalTapState,
  callbacks: DoubleTapCallbacks,
): Promise<void> {
  if (signal === 'SIGHUP') {
    await callbacks.onHangup?.();
    return;
  }
  if (state.isDoubleTap(signal)) {
    state.reset();
    await callbacks.onTwice?.(signal);
    return;
  }
  state.record(signal);
  await callbacks.onOnce?.(signal);
}

type MenuLogger = {
  log?: (msg: string, level?: string) => void | Promise<void>;
  warning?: (msg: string) => void | Promise<void>;
};

/**
 * start.js 菜单层信号：服务器子进程运行中不抢 SIGINT（由 loader 一次重启/两次退出）；
 * 菜单界面两次 Ctrl+C 退出程序；SIGHUP 杀子进程并退出。
 */
export class MenuSignalHandler {
  logger: MenuLogger;
  tap: SignalTapState;
  isSetup: boolean;
  inRestartLoop: boolean;
  onStopRestartLoop: (() => void | Promise<void>) | null;
  handlers: Record<string, () => void>;
  _rl: readline.Interface | null;

  constructor(logger: MenuLogger = {}) {
    this.logger = logger;
    this.tap = new SignalTapState();
    this.isSetup = false;
    this.inRestartLoop = false;
    this.onStopRestartLoop = null;
    this.handlers = {};
    this._rl = null;
  }

  _closeReadline(): void {
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
  }

  _ensureReadline(): void {
    if (!this.isSetup || !process.stdin || this._rl) return;
    this._rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this._rl.on('SIGINT', () => {
      process.emit('SIGINT');
    });
  }

  setup(): void {
    if (this.isSetup) return;
    for (const signal of SERVER_SIGNALS) {
      const handler = () => {
        void this._handle(signal);
      };
      this.handlers[signal] = handler;
      process.on(signal, handler);
    }
    this._ensureReadline();
    this.isSetup = true;
  }

  async cleanup(): Promise<void> {
    if (!this.isSetup) return;
    this._closeReadline();
    for (const [signal, handler] of Object.entries(this.handlers)) {
      process.removeListener(signal, handler);
    }
    this.handlers = {};
    this.isSetup = false;
    this.inRestartLoop = false;
    this.onStopRestartLoop = null;
    this.tap.reset();
  }

  async _handle(signal: string): Promise<void> {
    if (this.inRestartLoop && signal !== 'SIGHUP') return;

    await handleDoubleTapSignal(signal, this.tap, {
      onHangup: async () => {
        if (this.onStopRestartLoop) await this.onStopRestartLoop();
        await this.cleanup();
        process.exit(EXIT_STOP);
      },
      onTwice: async (sig) => {
        await this.logger.log?.(`检测到连续两次 ${sig}，准备退出`, 'INFO');
        await this.cleanup();
        process.exit(EXIT_STOP);
      },
      onOnce: async (sig) => {
        await this.logger.warning?.(`收到 ${sig}，再次发送将退出程序`);
      },
    });
  }
}
