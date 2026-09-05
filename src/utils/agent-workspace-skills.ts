/**
 * Agent Skills：与 OpenClaw `src/agents/skills/workspace.ts` 同结构的发现 / 预算 / 降级算法，
 * 实际加载与 XML 正文由 `@mariozechner/pi-coding-agent`（loadSkillsFromDir / formatSkillsForPrompt）完成。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from '@mariozechner/pi-coding-agent';
import { isPathInside, realpathSyncOrResolve } from '#utils/path-guards.js';
import { resolveSkillLimits, resolveSkillRoots } from '#utils/skills/config.js';

type SkillLimits = {
  maxCandidatesPerRoot: number;
  maxSkillsLoadedPerSource: number;
  maxSkillsInPrompt: number;
  maxSkillsPromptChars: number;
  maxSkillFileBytes: number;
};

function resolveContainedSkillPath({
  rootRealPath,
  candidatePath,
}: {
  rootRealPath: string;
  candidatePath: string;
}): string | null {
  const candidateRealPath = realpathSyncOrResolve(candidatePath);
  if (!isPathInside(rootRealPath, candidateRealPath)) return null;
  return candidateRealPath;
}

function listChildDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(entry.name);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(fullPath).isDirectory()) dirs.push(entry.name);
        } catch {
          /* broken symlink */
        }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

function resolveNestedSkillsRoot(
  dir: string,
  opts: { maxEntriesToScan?: number } = {},
): { baseDir: string } {
  const nested = path.join(dir, 'skills');
  try {
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) {
      return { baseDir: dir };
    }
  } catch {
    return { baseDir: dir };
  }

  const nestedDirs = listChildDirectories(nested);
  const scanLimit = Math.max(0, opts.maxEntriesToScan ?? 100);
  const toScan = scanLimit === 0 ? [] : nestedDirs.slice(0, Math.min(nestedDirs.length, scanLimit));

  for (const name of toScan) {
    const skillMd = path.join(nested, name, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      return { baseDir: nested };
    }
  }
  return { baseDir: dir };
}

function unwrapLoadedSkills(loaded: unknown): Skill[] {
  if (Array.isArray(loaded)) return loaded as Skill[];
  if (loaded && typeof loaded === 'object' && 'skills' in loaded) {
    const skills = (loaded as { skills: unknown }).skills;
    if (Array.isArray(skills)) return skills as Skill[];
  }
  return [];
}

function filterLoadedSkillsInsideRoot({
  skills,
  rootRealPath,
}: {
  skills: Skill[];
  rootRealPath: string;
}): Skill[] {
  return skills.filter((skill) => {
    const baseDirRealPath = resolveContainedSkillPath({
      rootRealPath,
      candidatePath: skill.baseDir,
    });
    if (!baseDirRealPath) return false;
    return Boolean(
      resolveContainedSkillPath({
        rootRealPath: baseDirRealPath,
        candidatePath: skill.filePath,
      }),
    );
  });
}

/**
 * OpenClaw loadSkillEntries → loadSkills 内层逻辑（单根目录）。
 */
function loadSkillsForOneRoot(
  params: { dir: string; source: string },
  limits: SkillLimits,
): Skill[] {
  const rootDir = path.resolve(params.dir);
  const rootRealPath = realpathSyncOrResolve(rootDir);
  const resolved = resolveNestedSkillsRoot(params.dir, {
    maxEntriesToScan: limits.maxCandidatesPerRoot,
  });
  const baseDir = resolved.baseDir;
  const baseDirRealPath = resolveContainedSkillPath({
    rootRealPath,
    candidatePath: baseDir,
  });
  if (!baseDirRealPath) return [];

  const rootSkillMd = path.join(baseDir, 'SKILL.md');
  if (fs.existsSync(rootSkillMd)) {
    const rootSkillRealPath = resolveContainedSkillPath({
      rootRealPath: baseDirRealPath,
      candidatePath: rootSkillMd,
    });
    if (!rootSkillRealPath) return [];
    try {
      const size = fs.statSync(rootSkillRealPath).size;
      if (size > limits.maxSkillFileBytes) return [];
    } catch {
      return [];
    }
    const loaded = loadSkillsFromDir({ dir: baseDir, source: params.source });
    return filterLoadedSkillsInsideRoot({
      skills: unwrapLoadedSkills(loaded),
      rootRealPath: baseDirRealPath,
    });
  }

  const childDirs = listChildDirectories(baseDir);
  // baseDir 没有 SKILL.md 时：maxCandidatesPerRoot 限制候选子目录数
  // maxSkillsLoadedPerSource 则由后续 break/load 数量共同约束最终加载数量
  const maxCandidates = Math.max(0, limits.maxCandidatesPerRoot);
  const limitedChildren = childDirs.slice().sort().slice(0, maxCandidates);

  const loadedSkills: Skill[] = [];
  for (const name of limitedChildren) {
    const skillDir = path.join(baseDir, name);
    const skillDirRealPath = resolveContainedSkillPath({
      rootRealPath: baseDirRealPath,
      candidatePath: skillDir,
    });
    if (!skillDirRealPath) continue;
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const skillMdRealPath = resolveContainedSkillPath({
      rootRealPath: baseDirRealPath,
      candidatePath: skillMd,
    });
    if (!skillMdRealPath) continue;
    try {
      const size = fs.statSync(skillMdRealPath).size;
      if (size > limits.maxSkillFileBytes) continue;
    } catch {
      continue;
    }

    const loaded = loadSkillsFromDir({ dir: skillDir, source: params.source });
    loadedSkills.push(
      ...filterLoadedSkillsInsideRoot({
        skills: unwrapLoadedSkills(loaded),
        rootRealPath: baseDirRealPath,
      }),
    );

    if (loadedSkills.length >= limits.maxSkillsLoadedPerSource) break;
  }

  if (loadedSkills.length > limits.maxSkillsLoadedPerSource) {
    return loadedSkills
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limits.maxSkillsLoadedPerSource);
  }
  return loadedSkills;
}

/** OpenClaw compactSkillPaths */
function compactSkillPaths(skills: Skill[]): Skill[] {
  const home = os.homedir();
  if (!home) return skills;
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return skills.map((s) => ({
    ...s,
    filePath: s.filePath.startsWith(prefix) ? `~/${s.filePath.slice(prefix.length)}` : s.filePath,
  }));
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** OpenClaw formatSkillsCompact（模块内用，不对外导出） */
function formatSkillsCompact(skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return '';
  const lines = [
    '\n\nThe following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its name.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];
  for (const skill of visible) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

/** OpenClaw applySkillsPromptLimits */
function applySkillsPromptLimits(
  skills: Skill[],
  limits: SkillLimits,
): { skillsForPrompt: Skill[]; compact: boolean } {
  const byCount = skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));
  let skillsForPrompt = byCount;
  let compact = false;

  const fitsFull = (s: Skill[]) => formatSkillsForPrompt(s).length <= limits.maxSkillsPromptChars;
  const compactBudget = limits.maxSkillsPromptChars;
  const fitsCompact = (s: Skill[]) => formatSkillsCompact(s).length <= compactBudget;

  if (!fitsFull(skillsForPrompt)) {
    if (fitsCompact(skillsForPrompt)) {
      compact = true;
    } else {
      compact = true;
      let lo = 0;
      let hi = skillsForPrompt.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsCompact(skillsForPrompt.slice(0, mid))) lo = mid;
        else hi = mid - 1;
      }
      skillsForPrompt = skillsForPrompt.slice(0, lo);
    }
  }

  return { skillsForPrompt, compact };
}

/**
 * @param workspaceRootResolved 已 realpath 的工作区根
 * @param runtimeConfig agentWorkspace 中与 skills 相关字段
 * @returns XML 技能目录或空串
 */
export function buildSkillsPromptFromWorkspace(
  workspaceRootResolved: string,
  runtimeConfig: Record<string, any> = {},
): string {
  const limits = resolveSkillLimits(runtimeConfig) as SkillLimits;
  const skillRoots = resolveSkillRoots(runtimeConfig) as string[];

  const merged = new Map<string, Skill>();
  for (const rel of skillRoots) {
    const abs = path.isAbsolute(rel) ? path.normalize(rel) : path.join(workspaceRootResolved, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    const slug = String(rel).replace(/[^\w.-]+/g, '_');
    const loaded = loadSkillsForOneRoot({ dir: abs, source: `xrk-${slug}` }, limits);
    for (const skill of loaded) {
      merged.set(skill.name, skill);
    }
  }

  const resolvedSkills = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (resolvedSkills.length === 0) return '';

  const promptSkills = compactSkillPaths(resolvedSkills);
  const { skillsForPrompt, compact } = applySkillsPromptLimits(promptSkills, limits);
  const totalSkills = resolvedSkills.length;
  const maxChars = limits.maxSkillsPromptChars;

  const buildCombined = (subsetSkills: Skill[], useCompact: boolean): string => {
    if (!Array.isArray(subsetSkills) || subsetSkills.length === 0) return '';
    const included = subsetSkills.length;
    const isTruncated = included < totalSkills;

    const note = isTruncated
      ? `⚠️ Skills truncated: included ${included} of ${totalSkills}${useCompact ? ' (compact format, descriptions omitted)' : ''}.`
      : useCompact
        ? '⚠️ Skills catalog using compact format (descriptions omitted).'
        : '';

    const xml = useCompact ? formatSkillsCompact(subsetSkills) : formatSkillsForPrompt(subsetSkills);
    return [note, xml].filter(Boolean).join('\n');
  };

  // applySkillsPromptLimits 已保证 skills XML 自身预算大概率满足；
  // 这里再把 truncationNote 与最终拼接结果纳入精确预算，避免最终超限。
  const initial = buildCombined(skillsForPrompt, compact);
  if (initial.length <= maxChars) return initial;

  const modes = compact ? [true] : [false, true];
  for (const useCompact of modes) {
    const direct = buildCombined(skillsForPrompt, useCompact);
    if (direct.length <= maxChars) return direct;

    let lo = 0;
    let hi = skillsForPrompt.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const subset = skillsForPrompt.slice(0, mid);
      const combined = buildCombined(subset, useCompact);
      if (combined.length <= maxChars) lo = mid;
      else hi = mid - 1;
    }

    const best = buildCombined(skillsForPrompt.slice(0, lo), useCompact);
    if (best.length > 0) return best;
  }

  return '';
}
