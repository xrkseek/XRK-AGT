export function normalizeError(err: unknown): Error {
  // Node ≥26：用 Error.isError；禁止基础设施式 instanceof 判错（node26-runtime-gate）
  if (Error.isError(err)) return err;
  return new Error(String(err));
}
