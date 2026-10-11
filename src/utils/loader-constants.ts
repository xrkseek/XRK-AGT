/** Loader 扫描与批处理约定 */

export const SCAN_IGNORE_PREFIXES = Object.freeze(['.', '_'] as const);

export const LOADER_BATCH_SIZE = 10;

export const API_REGISTER_BATCH_SIZE = 8;
