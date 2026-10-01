import { normalizeError } from '#utils/normalize-error.js';

/**
 * Playwright 目标崩溃识别与安全关闭（不降截图质量，只做恢复路径）
 */

const CRASH_RE =
  /Target crashed|Page crashed|Target closed|has been closed|Browser (has been )?closed|Connection closed|Browser closed|Session closed|Execution context was destroyed/i;

export function isPlaywrightCrashError(err: unknown): boolean {
  if (err == null) return false;
  return CRASH_RE.test(normalizeError(err).message);
}

function resolveOnAbortTimeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const signal = AbortSignal.timeout(ms);
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * close 可能在崩溃后挂起；超时后放弃等待（进程侧仍可能残留，由下次 launch 隔离）
 */
export async function softClosePlaywright(
  target: { close?: () => Promise<unknown> } | null | undefined,
  timeoutMs = 8000,
): Promise<void> {
  if (!target || typeof target.close !== 'function') return;
  const ms = Math.min(Math.max(Number(timeoutMs) || 8000, 500), 60_000);
  try {
    await Promise.race([
      Promise.resolve(target.close()).catch(() => {}),
      resolveOnAbortTimeout(ms),
    ]);
  } catch {
    /* ignore */
  }
}

/**
 * 按 page → context → browser 顺序软关闭
 */
export async function softClosePlaywrightTree(
  targets: {
    page?: { close?: () => Promise<unknown> };
    context?: { close?: () => Promise<unknown> };
    browser?: { close?: () => Promise<unknown> };
  } = {},
  timeoutMs = 8000,
): Promise<void> {
  const { page, context, browser } = targets;
  await softClosePlaywright(page, timeoutMs);
  await softClosePlaywright(context, timeoutMs);
  await softClosePlaywright(browser, timeoutMs);
}
