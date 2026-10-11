import { DEFAULT_SKILL_LIMITS } from '#utils/skills/defaults.js';
import { normalizeStringArray } from '#utils/string-array-utils.js';

type SkillRuntimeConfig = {
  customSkillRoots?: unknown;
  maxCandidatesPerRoot?: number;
  maxSkillsLoadedPerSource?: number;
  maxSkillsInPrompt?: number;
  maxSkillsPromptChars?: number;
  maxSkillFileBytes?: number;
};

function uniqueList(list: string[]): string[] {
  return [...new Set(list)];
}

export function resolveSkillRoots(runtimeConfig: SkillRuntimeConfig = {}): string[] {
  const customSkillRoots = normalizeStringArray(runtimeConfig.customSkillRoots);
  // 助手 agent：默认不注入 skills；仅当用户在配置里显式提供 customSkillRoots 时才注入
  return uniqueList(customSkillRoots);
}

export function resolveSkillLimits(runtimeConfig: SkillRuntimeConfig = {}) {
  return {
    maxCandidatesPerRoot: runtimeConfig.maxCandidatesPerRoot ?? DEFAULT_SKILL_LIMITS.maxCandidatesPerRoot,
    maxSkillsLoadedPerSource: runtimeConfig.maxSkillsLoadedPerSource ?? DEFAULT_SKILL_LIMITS.maxSkillsLoadedPerSource,
    maxSkillsInPrompt: runtimeConfig.maxSkillsInPrompt ?? DEFAULT_SKILL_LIMITS.maxSkillsInPrompt,
    maxSkillsPromptChars: runtimeConfig.maxSkillsPromptChars ?? DEFAULT_SKILL_LIMITS.maxSkillsPromptChars,
    maxSkillFileBytes: runtimeConfig.maxSkillFileBytes ?? DEFAULT_SKILL_LIMITS.maxSkillFileBytes,
  };
}
