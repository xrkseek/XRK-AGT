export function normalizeError(err: unknown): Error {
  // Node ≥26：用 Error.isError；禁止基础设施式 instanceof 判错（node26-runtime-gate）
  if (Error.isError(err)) return err;
  return new Error(String(err));
}

/** 错误转可读消息；与 normalizeError(err).message 等价，供日志与错误文案直接取用。 */
export function errMsg(err: unknown): string {
  return normalizeError(err).message;
}