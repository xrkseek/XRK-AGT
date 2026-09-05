/** act-policy.ts 移植 — 浏览器交互上限 */

export const ACT_MAX_BATCH_ACTIONS = 100;
export const ACT_MAX_BATCH_DEPTH = 5;
export const ACT_MAX_CLICK_DELAY_MS = 5000;
export const ACT_MAX_WAIT_TIME_MS = 30000;
export const ACT_MAX_VIEWPORT_DIMENSION = 8192;
export const ACT_DEFAULT_INTERACTION_TIMEOUT_MS = 8000;
export const ACT_MAX_INTERACTION_TIMEOUT_MS = 60000;
export const ACT_DEFAULT_WAIT_TIMEOUT_MS = 20000;
export const ACT_MAX_WAIT_TIMEOUT_MS = 120000;
export const ACT_DEFAULT_SNAPSHOT_TIMEOUT_MS = 5000;
export const ACT_MAX_SNAPSHOT_TIMEOUT_MS = 60000;
export const INTERACTION_NAVIGATION_GRACE_MS = 250;

export function clampInteractionTimeoutMs(
  raw: unknown,
  fallback: number = ACT_DEFAULT_INTERACTION_TIMEOUT_MS,
): number {
  const n = Math.floor(Number(raw) || fallback);
  return Math.min(ACT_MAX_INTERACTION_TIMEOUT_MS, Math.max(500, n));
}

export function clampWaitTimeoutMs(
  raw: unknown,
  fallback: number = ACT_DEFAULT_WAIT_TIMEOUT_MS,
): number {
  const n = Math.floor(Number(raw) || fallback);
  return Math.min(ACT_MAX_WAIT_TIMEOUT_MS, Math.max(500, n));
}

export function clampClickDelayMs(raw: unknown): number {
  const n = Math.floor(Number(raw) || 0);
  return Math.min(ACT_MAX_CLICK_DELAY_MS, Math.max(0, n));
}

export function clampWaitTimeMs(raw: unknown): number {
  const n = Math.floor(Number(raw) || 0);
  return Math.min(ACT_MAX_WAIT_TIME_MS, Math.max(0, n));
}
