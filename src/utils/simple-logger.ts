import fs from 'node:fs/promises';
import path from 'node:path';

export type SimpleLogLevel = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';

export type SimpleLogger = {
  log: (message: string, level?: SimpleLogLevel) => Promise<void>;
  info: (message: string) => Promise<void>;
  success: (message: string) => Promise<void>;
  warning: (message: string) => Promise<void>;
  error: (message: string) => Promise<void>;
};

/**
 * 轻量文件日志（零第三方依赖；引导阶段与 restart 日志共用）
 */
export function createSimpleLogger(logFile: string, silent = false): SimpleLogger {
  const colors: Record<string, string> = {
    INFO: '\x1b[36m',
    SUCCESS: '\x1b[32m',
    WARNING: '\x1b[33m',
    ERROR: '\x1b[31m',
    RESET: '\x1b[0m',
  };

  async function writeLog(message: string, level: SimpleLogLevel = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;

    try {
      await fs.mkdir(path.dirname(logFile), { recursive: true });
      await fs.appendFile(logFile, logMessage, 'utf8');
      if (!silent || level === 'ERROR' || level === 'SUCCESS') {
        const color = colors[level] || '';
        console.log(`${color}${message}${colors.RESET}`);
      }
    } catch (error) {
      const err = error as { message?: string };
      console.error(`日志写入失败 [${level}]: ${err.message}`);
      if (!silent) console.log(message);
    }
  }

  return {
    log: (message, level = 'INFO') => writeLog(message, level),
    info: (message) => writeLog(message, 'INFO'),
    success: (message) => writeLog(message, 'SUCCESS'),
    warning: (message) => writeLog(message, 'WARNING'),
    error: (message) => writeLog(message, 'ERROR'),
  };
}
