import YAML from 'yaml';
import { normalizeError } from '#utils/normalize-error.js';

import {
  pickFirstExistingSync,
  readTextFilesSync,
  statFiles,
} from '#utils/core-fs.js';

type ConfigParseError = Error & { configLabel?: string; configPath?: string };

/**
 * 从候选路径加载首个存在的 YAML。
 */
export function loadYamlFromCandidates(
  candidates: string[],
  logLabel = 'config',
): { config: object; watchFile: string | null } {
  const paths = candidates.filter(Boolean);
  const idx = pickFirstExistingSync(paths);
  if (idx < 0) return { config: {}, watchFile: null };

  const watchFile = paths[idx]!;
  const raw = readTextFilesSync([watchFile])[0];
  if (!raw) return { config: {}, watchFile };

  try {
    return { config: (YAML.parse(raw) as object) || {}, watchFile };
  } catch (error) {
    const err = normalizeError(error) as ConfigParseError;
    err.configLabel = logLabel;
    err.configPath = watchFile;
    throw err;
  }
}

/**
 * 批量读取 YAML 文本。
 */
export function readYamlTextsBatch(paths: string[]): Map<string, string> {
  const unique = [...new Set(paths.filter(Boolean))];
  const texts = readTextFilesSync(unique);
  const map = new Map<string, string>();
  unique.forEach((p, i) => {
    if (texts[i] != null) map.set(p, texts[i]!);
  });
  return map;
}

/**
 * 合并 default / server YAML 文本。
 */
export function mergeYamlTexts(
  defaultText: string | undefined,
  serverText: string | undefined,
): object {
  const defaultConfig = defaultText ? (YAML.parse(defaultText) as object) : {};
  const serverConfig = serverText ? (YAML.parse(serverText) as object) : {};
  return { ...defaultConfig, ...serverConfig };
}

/** 文件是否存在（statFiles 首项） */
export function fileExistsSync(filePath: string): boolean {
  return Boolean(statFiles([filePath])[0]);
}
