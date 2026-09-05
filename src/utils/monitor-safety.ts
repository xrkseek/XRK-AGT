/**
 * SystemMonitor 企业安全边界（纯函数库）。
 *
 * 约定：
 * - 有副作用的开关须配置为显式 `true` 才开启（缺字段 / 旧 yaml 一律关）
 * - 删文件仅限约定根目录，且经 realpath 防路径跳出
 * - 杀进程仅限托管浏览器，且禁止杀本进程 / 父进程
 * - 自动重启只认本进程 Node 堆，不认整机内存
 *
 * 消费方：`src/modules/systemmonitor.js`、`src/infrastructure/config/loader.js`
 * 默认模板：`config/default_config/monitor.yaml`
 *
 * @module #utils/monitor-safety
 */
import path from 'node:path';
import fs from 'node:fs/promises';

/** 规范化后的监控配置（字段齐全、副作用项为布尔真值）。 */
export type NormalizedMonitorConfig = {
  enabled: boolean;
  interval: number;
  initialDelay: number;
  browser: {
    enabled: boolean;
    maxInstances: number;
    memoryThreshold: number;
    reserveNewest: boolean;
  };
  memory: {
    enabled: boolean;
    systemThreshold: number;
    nodeThreshold: number;
    autoOptimize: boolean;
    gcInterval: number;
    leakDetection: {
      enabled: boolean;
      threshold: number;
      checkInterval: number;
    };
  };
  cpu: { enabled: boolean; threshold: number; checkDuration: number };
  optimize: { aggressive: boolean; autoRestart: boolean; restartThreshold: number };
  report: { enabled: boolean; interval: number };
  disk: {
    enabled: boolean;
    cleanupTemp: boolean;
    cleanupLogs: boolean;
    tempMaxAge: number;
    logMaxAge: number;
    maxLogSize: number;
  };
  network: { enabled: boolean; maxConnections: number; cleanupIdle: boolean };
  process: { enabled: boolean; priority: string; nice: number };
  system: { enabled: boolean; clearCache: boolean; optimizeCPU: boolean };
};

/**
 * 运行中不可 unlink 的日志基名（即使 `disk.cleanupLogs === true`）。
 * 大小写不敏感，匹配时会 `toLowerCase()`。
 */
export const PROTECTED_LOG_BASENAMES: ReadonlySet<string> = new Set([
  'app.log',
  'bootstrap.log',
  'restart.log',
  'trace.log',
  'error.log',
]);

/**
 * 将原始 `runtimeConfig.monitor` / yaml 规范为企业安全默认。
 *
 * - 观察类开关：缺省偏开（监控本身）
 * - 副作用类开关：仅 `=== true` 才开（browser / network / process / system / 删文件 / 激进 / 自重启）
 */
export function normalizeMonitorConfig(raw: unknown): NormalizedMonitorConfig {
  const config = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
  return {
    enabled: config.enabled !== false,
    interval: Number(config.interval) > 0 ? Number(config.interval) : 300000,
    initialDelay: Number(config.initialDelay) > 0 ? Number(config.initialDelay) : 2000,
    browser: {
      enabled: config.browser?.enabled === true,
      maxInstances: Number(config.browser?.maxInstances) > 0 ? Number(config.browser.maxInstances) : 5,
      memoryThreshold: Number(config.browser?.memoryThreshold) || 90,
      reserveNewest: config.browser?.reserveNewest !== false,
    },
    memory: {
      enabled: config.memory?.enabled !== false,
      systemThreshold: Number(config.memory?.systemThreshold) || 90,
      nodeThreshold: Number(config.memory?.nodeThreshold) || 85,
      autoOptimize: config.memory?.autoOptimize !== false,
      gcInterval: Number(config.memory?.gcInterval) || 600000,
      leakDetection: {
        enabled: config.memory?.leakDetection?.enabled !== false,
        threshold: Number(config.memory?.leakDetection?.threshold) || 0.1,
        checkInterval: Number(config.memory?.leakDetection?.checkInterval) || 300000,
      },
    },
    cpu: {
      enabled: config.cpu?.enabled !== false,
      threshold: Number(config.cpu?.threshold) || 90,
      checkDuration: Number(config.cpu?.checkDuration) || 30000,
    },
    optimize: {
      aggressive: config.optimize?.aggressive === true,
      autoRestart: config.optimize?.autoRestart === true,
      restartThreshold: Number(config.optimize?.restartThreshold) || 95,
    },
    report: {
      enabled: config.report?.enabled !== false,
      interval: Number(config.report?.interval) || 3600000,
    },
    disk: {
      enabled: config.disk?.enabled !== false,
      cleanupTemp: config.disk?.cleanupTemp === true,
      cleanupLogs: config.disk?.cleanupLogs === true,
      tempMaxAge: Number(config.disk?.tempMaxAge) || 86400000,
      logMaxAge: Number(config.disk?.logMaxAge) || 604800000,
      maxLogSize: Number(config.disk?.maxLogSize) || 100 * 1024 * 1024,
    },
    network: {
      enabled: config.network?.enabled === true,
      maxConnections: Number(config.network?.maxConnections) || 1000,
      cleanupIdle: config.network?.cleanupIdle === true,
    },
    process: {
      enabled: config.process?.enabled === true,
      priority: config.process?.priority || 'normal',
      nice: Number(config.process?.nice) || 0,
    },
    system: {
      enabled: config.system?.enabled === true,
      clearCache: config.system?.clearCache === true,
      optimizeCPU: config.system?.optimizeCPU === true,
    },
  };
}

/**
 * 判断命令行是否为 AGT 托管的浏览器（headless / puppeteer / playwright 等）。
 * 未命中则禁止 taskkill，避免误伤用户桌面 Chrome。
 */
export function isManagedBrowserCommand(commandLine?: string): boolean {
  const s = String(commandLine || '').toLowerCase();
  if (s.includes('puppeteer') || s.includes('playwright') || s.includes('--headless')) return true;
  if (s.includes('xrk-agt') || s.includes('xr-agt')) return true;
  return s.includes('user-data-dir') && (s.includes('temp') || s.includes('tmp') || s.includes('chromium'));
}

/**
 * 判断 PID 是否允许被监控器结束。
 * 拒绝：非正整数、当前进程、父进程。
 */
export function isSafeKillPid(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === process.pid) return false;
  if (process.ppid && n === process.ppid) return false;
  return true;
}

/**
 * 允许自动清理的临时目录根（绝对路径）。
 * 当前仅 `data/temp`，不含 `data/uploads`。
 */
export function allowedTempRoots(cwd: string = process.cwd()): string[] {
  return [path.resolve(cwd, 'data', 'temp')];
}

/**
 * 允许自动清理日志的目录根（绝对路径）。
 */
export function allowedLogRoot(cwd: string = process.cwd()): string {
  return path.resolve(cwd, 'logs');
}

/**
 * 判断 `filePath` 是否位于任一 `allowedRoots` 之下（realpath，防 `../` 跳出）。
 */
export async function isPathInsideAllowedRoots(
  filePath: string,
  allowedRoots: string[],
): Promise<boolean> {
  let resolvedFile: string;
  try {
    resolvedFile = await fs.realpath(filePath);
  } catch {
    resolvedFile = path.resolve(filePath);
  }
  for (const root of allowedRoots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await fs.realpath(root);
    } catch {
      resolvedRoot = path.resolve(root);
    }
    const rel = path.relative(resolvedRoot, resolvedFile);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    if (rel === '') return true;
  }
  return false;
}

/**
 * 是否为受保护的活跃日志基名（不可自动删除）。
 * @returns `true` 表示受保护、不可删
 */
export function isProtectedLogBasename(basename?: string): boolean {
  return PROTECTED_LOG_BASENAMES.has(String(basename || '').toLowerCase());
}

/**
 * 是否应因 Node 堆过高触发 autoRestart。
 * 禁止用整机内存占比（企业共享机常态偏高）。
 */
export function shouldAutoRestartForHeap(
  processMem: { heapUsedPercent?: number } | null | undefined,
  optimize: { autoRestart?: boolean; restartThreshold?: number } | null | undefined,
): boolean {
  if (optimize?.autoRestart !== true) return false;
  const heap = Number(processMem?.heapUsedPercent);
  const th = Number(optimize?.restartThreshold) || 95;
  return Number.isFinite(heap) && heap > th;
}

/**
 * 是否允许执行 OS 级缓存清理（如 Windows `ipconfig /flushdns`）。
 * Windows 另须 `optimize.aggressive === true`。
 */
export function mayClearOsCache(
  runtimeConfig: {
    system?: { clearCache?: boolean };
    optimize?: { aggressive?: boolean };
  } | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (runtimeConfig?.system?.clearCache !== true) return false;
  if (platform === 'win32' && runtimeConfig?.optimize?.aggressive !== true) return false;
  return true;
}
