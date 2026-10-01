import RuntimeUtil from '#utils/runtime-util.js';
import chalk from 'chalk';
import { normalizeError } from '#utils/normalize-error.js';

/**
 * 错误类型枚举
 */
export const ErrorCodes = {
  // 工作流错误 (1000-1999)
  WORKFLOW_EXECUTION_FAILED: 1001,
  WORKFLOW_NOT_FOUND: 1002,
  WORKFLOW_ALREADY_RUNNING: 1003,
  WORKFLOW_MAX_ITERATIONS: 1004,

  // 插件错误 (2000-2999)
  PLUGIN_LOAD_FAILED: 2001,
  PLUGIN_EXECUTION_FAILED: 2002,
  PLUGIN_NOT_FOUND: 2003,

  // 输入验证错误 (3000-3999)
  INVALID_INPUT: 3001,
  INVALID_PATH: 3002,
  INVALID_COMMAND: 3003,
  PATH_TRAVERSAL: 3004,
  INPUT_VALIDATION_FAILED: 3005,

  // 系统错误 (4000-4999)
  SYSTEM_ERROR: 4001,
  MEMORY_ERROR: 4002,
  NETWORK_ERROR: 4003,
  NOT_FOUND: 4004,

  // 配置错误 (5000-5999)
  CONFIG_ERROR: 5001,
  CONFIG_NOT_FOUND: 5002,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

type ErrorStat = {
  count: number;
  firstOccurrence: number;
  lastOccurrence: number;
  contexts: Array<{ message: string; timestamp: number; context: Record<string, unknown> }>;
};

type MapWithGetOrInsert<K, V> = Map<K, V> & {
  getOrInsertComputed(key: K, callbackfn: () => V): V;
};

/**
 * 统一错误处理类
 * 提供标准化的错误处理、分类和恢复机制
 */
export class RuntimeError extends Error {
  code: ErrorCode | number;
  context: Record<string, unknown>;
  timestamp: number;

  constructor(
    message: string,
    code: ErrorCode | number = ErrorCodes.SYSTEM_ERROR,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    this.context = context;
    this.timestamp = Date.now();
    Error.captureStackTrace(this, RuntimeError);
  }

  /**
   * 从普通错误创建RuntimeError
   */
  static fromError(
    error: unknown,
    code: ErrorCode | number = ErrorCodes.SYSTEM_ERROR,
    context: Record<string, unknown> = {},
  ): RuntimeError {
    if (error instanceof RuntimeError) {
      return error;
    }

    const normalized = normalizeError(error);
    const safeOriginal = {
      name: normalized.name,
      message: normalized.message,
      stack: typeof normalized.stack === 'string' ? normalized.stack : undefined,
    };

    const botError = new RuntimeError(normalized.message || '未知错误', code, {
      ...context,
      original: safeOriginal,
    });

    if (normalized.stack) botError.stack = normalized.stack;

    return botError;
  }

  /**
   * 判断错误是否可恢复
   */
  isRecoverable(): boolean {
    const recoverableCodes: Array<ErrorCode | number> = [
      ErrorCodes.NETWORK_ERROR,
      ErrorCodes.WORKFLOW_MAX_ITERATIONS,
    ];
    return recoverableCodes.includes(this.code);
  }

  /**
   * 获取错误严重程度
   */
  getSeverity(): ErrorSeverity {
    if (this.code >= 4000) return 'critical';
    if (this.code >= 3000) return 'high';
    if (this.code >= 2000) return 'medium';
    return 'low';
  }

  /**
   * 转换为可序列化的对象
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      timestamp: this.timestamp,
      severity: this.getSeverity(),
      recoverable: this.isRecoverable(),
    };
  }
}

/**
 * 错误处理器
 * 统一处理、记录和恢复错误
 */
export class ErrorHandler {
  errorStats = new Map<string, ErrorStat>();
  recoveryStrategies = new Map<ErrorCode | number, (error: RuntimeError) => unknown>();

  /**
   * 处理错误
   */
  handle(
    error: Error | RuntimeError | (Error & { code?: number; context?: Record<string, unknown> }),
    context: Record<string, unknown> = {},
    shouldLog = true,
  ): unknown {
    const errAny = error as Error & { code?: number; context?: Record<string, unknown> };
    const botError = RuntimeError.fromError(error, errAny.code ?? ErrorCodes.SYSTEM_ERROR, {
      ...context,
      ...(errAny.context || {}),
    });

    this.recordError(botError);

    if (shouldLog) {
      this.logError(botError);
    }

    if (botError.isRecoverable()) {
      return this.attemptRecovery(botError);
    }

    return botError;
  }

  /**
   * 记录错误统计
   */
  recordError(error: RuntimeError): void {
    const key = `${error.code}`;
    const stats = (this.errorStats as MapWithGetOrInsert<string, ErrorStat>).getOrInsertComputed(
      key,
      () => ({
        count: 0,
        firstOccurrence: Date.now(),
        lastOccurrence: Date.now(),
        contexts: [],
      }),
    );

    stats.count++;
    stats.lastOccurrence = Date.now();
    if (stats.contexts.length < 10) {
      stats.contexts.push({
        message: error.message,
        timestamp: error.timestamp,
        context: error.context,
      });
    }
  }

  /**
   * 记录错误日志
   */
  logError(error: RuntimeError): void {
    const severity = error.getSeverity();
    const level =
      ['critical', 'high'].includes(severity) ? 'error' : severity === 'medium' ? 'warn' : 'info';

    const logMessage = `[${error.code}] ${error.message}`;
    const contextStr =
      Object.keys(error.context).length > 0
        ? `\n上下文: ${JSON.stringify(error.context, null, 2)}`
        : '';

    RuntimeUtil.makeLog(level, chalk.red(`✗ ${logMessage}${contextStr}`), 'ErrorHandler');

    if (severity === 'critical' && error.stack) {
      RuntimeUtil.makeLog('debug', chalk.gray(error.stack), 'ErrorHandler');
    }
  }

  /**
   * 尝试恢复错误
   */
  attemptRecovery(error: RuntimeError): unknown {
    const strategy = this.recoveryStrategies.get(error.code);
    if (typeof strategy === 'function') {
      try {
        return strategy(error);
      } catch (recoveryError) {
        RuntimeUtil.makeLog(
          'error',
          `恢复策略执行失败: ${normalizeError(recoveryError).message}`,
          'ErrorHandler',
        );
      }
    }
  }

  /**
   * 注册恢复策略
   */
  registerRecoveryStrategy(
    code: ErrorCode | number,
    strategy: (error: RuntimeError) => unknown,
  ): void {
    this.recoveryStrategies.set(code, strategy);
  }

  /**
   * 获取错误统计报告
   */
  getErrorReport(): {
    totalErrors: number;
    byCode: Record<string, ErrorStat>;
    bySeverity: Record<ErrorSeverity, number>;
    topErrors: Array<{ code: string } & ErrorStat>;
  } {
    const report = {
      totalErrors: 0,
      byCode: {} as Record<string, ErrorStat>,
      bySeverity: { low: 0, medium: 0, high: 0, critical: 0 } as Record<ErrorSeverity, number>,
      topErrors: [] as Array<{ code: string } & ErrorStat>,
    };

    const getSeverityByCode = (code: string): ErrorSeverity => {
      const numCode = Number(code);
      if (numCode >= 4000) return 'critical';
      if (numCode >= 3000) return 'high';
      if (numCode >= 2000) return 'medium';
      return 'low';
    };

    for (const [code, stats] of this.errorStats.entries()) {
      report.totalErrors += stats.count;
      report.byCode[code] = stats;
      report.bySeverity[getSeverityByCode(code)] += stats.count;
    }

    report.topErrors = Array.from(this.errorStats.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([code, stats]) => ({ code, ...stats }));

    return report;
  }

  /**
   * 清理错误统计
   */
  clearStats(): void {
    this.errorStats.clear();
  }
}

// 全局错误处理器实例
export const errorHandler = new ErrorHandler();
