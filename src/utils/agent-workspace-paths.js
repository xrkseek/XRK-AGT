/**
 * Agent 工作区路径约定（对齐 OpenClaw：独立工作区目录，非项目根）。
 *
 * - 根目录 AGENTS.md：IDE 开发规则，不参与运行时
 * - `agents/` + `.xrk/skills/`：仓库内 Agent 面（模板 / 规则 / 技能种子 / subagents）
 * - data/ai-workspace/{id}/*：运行时工作区（AGENTS.md、SOUL.md、rules/、skills/、core/、memory/…）
 */
import fs from 'node:fs';
import path from 'node:path';
import paths from '#utils/paths.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { isPathInside, realpathSyncOrResolve } from '#utils/path-guards.js';

export const AGENTS_MD = 'AGENTS.md';

/** 仓库内办事助手种子根（workspace / rules / recipes / microagents / subagents） */
export const PROJECT_AGENTS_DIR_REL = 'agents';

/** subagents 清单文件名（工作区根与 agents/ 下均支持） */
export const AGENT_MANIFEST_BASENAMES = ['subagents.yaml', 'subagents.yml', 'subagents.json'];

/** 工作区根目录下的助手模板文件名（OpenClaw 风格扁平布局） */
export const WORKSPACE_TEMPLATE_RELS = [
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'ENV.md',
  'HEARTBEAT.md',
];

/** 相对工作区根：长期记忆文件 */
export const LONG_TERM_MEMORY_REL = 'memory/MEMORY.md';

/** 仓库内首次引导用的模板目录（只读，运行时不从此处注入） */
export const WORKSPACE_BUNDLE_DIR_REL = `${PROJECT_AGENTS_DIR_REL}/workspace`;

/** 项目级共享规则（运行时注入；≠ `.cursor/rules`；`.mdc` 带 `xrk-inject: false` 不进 XRKH standing） */
export const PROJECT_RULES_DIR_REL = `${PROJECT_AGENTS_DIR_REL}/rules`;

/** 项目级 subagents 清单种子 */
export const PROJECT_SUBAGENTS_REL = `${PROJECT_AGENTS_DIR_REL}/subagents.yaml`;

/** 项目级配方与 microagents 目录 */
export const PROJECT_RECIPES_DIR_REL = `${PROJECT_AGENTS_DIR_REL}/recipes`;
export const PROJECT_MICROAGENTS_DIR_REL = `${PROJECT_AGENTS_DIR_REL}/microagents`;

/** 工作区内用户规则目录（相对 data/ai-workspace/{id}；同相对路径覆盖项目规则） */
export const WORKSPACE_RULES_DIR = 'rules';

/** 办公技能包（复制到工作区 skills/，与 ai-workflow customSkillRoots 对齐） */
export const PROJECT_SKILLS_STANDARD_REL = '.xrk/skills';

/** 工作区内技能目录名（相对 data/ai-workspace/{id}） */
export const WORKSPACE_SKILLS_DIR = 'skills';

export const DEFAULT_WORKSPACE_ID = 'default';

/** 项目根下 agents/ 子路径（绝对） */
export function projectAgentsAbs(projectRoot, ...segments) {
  return path.join(projectRoot, PROJECT_AGENTS_DIR_REL, ...segments);
}

/** 项目根下 agents/ 子路径（相对项目根，POSIX 斜杠） */
export function projectAgentsRel(...segments) {
  return path.posix.join(PROJECT_AGENTS_DIR_REL, ...segments);
}

/**
 * 缺文件才拷；不覆盖已有（用户定制优先）。
 * @param {string} srcDir
 * @param {string} destDir
 * @param {{ skipNames?: Set<string> }} [opts]
 */
export function copyTreeMissingOnly(srcDir, destDir, opts = {}) {
  if (!fs.existsSync(srcDir)) return;
  const skipNames = opts.skipNames instanceof Set ? opts.skipNames : new Set();
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeMissingOnly(src, dest, opts);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

export function getProjectRoot() {
  return paths.root || process.cwd();
}

export function normalizeWorkspaceId(raw) {
  let id = String(raw || DEFAULT_WORKSPACE_ID).trim() || DEFAULT_WORKSPACE_ID;
  if (id === 'desktop') id = DEFAULT_WORKSPACE_ID;
  return id.replace(/[^\w.\u4e00-\u9fa5-]/g, '_').slice(0, 64) || DEFAULT_WORKSPACE_ID;
}

export function getConfiguredDefaultWorkspaceId() {
  const runtimeConfig = getAiWorkflowConfigOptional();
  const raw = runtimeConfig?.workspace?.defaultId;
  if (raw != null && String(raw).trim() !== '') {
    return normalizeWorkspaceId(raw);
  }
  return DEFAULT_WORKSPACE_ID;
}

export function getAgentWorkspacesRoot() {
  return paths.dataAiWorkspace || path.join(paths.data, 'ai-workspace');
}

export function getAgentWorkspaceAbs(id = DEFAULT_WORKSPACE_ID) {
  return path.join(getAgentWorkspacesRoot(), normalizeWorkspaceId(id));
}

export function isAgentDataWorkspaceAbs(absPath) {
  if (!absPath) return false;
  try {
    const wsRoot = realpathSyncOrResolve(getAgentWorkspacesRoot());
    return isPathInside(wsRoot, realpathSyncOrResolve(absPath));
  } catch {
    return false;
  }
}

/**
 * 技能扫描根（绝对路径，字典序稳定）。
 * customSkillRoots 有值则用配置；否则回退项目 standard。
 * 工作区 skills/ 若存在则追加（同名技能后写覆盖）。
 */
export function resolveSkillRootAbsList({ projectRoot, workspaceRoot, customSkillRoots = [] } = {}) {
  const roots = new Set();
  const configured = Array.isArray(customSkillRoots)
    ? customSkillRoots.filter(Boolean).map(String)
    : [];
  for (const rel of configured) {
    roots.add(path.isAbsolute(rel) ? path.normalize(rel) : path.join(projectRoot, rel));
  }
  if (!configured.length) {
    roots.add(path.join(projectRoot, PROJECT_SKILLS_STANDARD_REL));
  }
  if (workspaceRoot) {
    const wsSkills = path.join(workspaceRoot, WORKSPACE_SKILLS_DIR);
    if (fs.existsSync(wsSkills)) roots.add(wsSkills);
  }
  return [...roots].sort((a, b) => a.localeCompare(b));
}

/** 从仓库 `agents/workspace` + `.xrk/skills` 种子复制缺失项到 data 工作区（不覆盖已有） */
export function seedWorkspaceFromBundle(workspaceAbs) {
  if (!isAgentDataWorkspaceAbs(workspaceAbs)) return;
  fs.mkdirSync(workspaceAbs, { recursive: true });
  fs.mkdirSync(path.join(workspaceAbs, 'memory'), { recursive: true });

  const projectRoot = getProjectRoot();
  const bundleDir = projectAgentsAbs(projectRoot, 'workspace');
  const seedNames = [AGENTS_MD, ...WORKSPACE_TEMPLATE_RELS];

  for (const name of seedNames) {
    const dest = path.join(workspaceAbs, name);
    if (fs.existsSync(dest)) continue;
    const src = path.join(bundleDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  const bundleMemory = path.join(bundleDir, LONG_TERM_MEMORY_REL);
  const wsMemory = path.join(workspaceAbs, LONG_TERM_MEMORY_REL);
  if (!fs.existsSync(wsMemory) && fs.existsSync(bundleMemory)) {
    fs.copyFileSync(bundleMemory, wsMemory);
  }

  const wsRules = path.join(workspaceAbs, WORKSPACE_RULES_DIR);
  // 工作区 rules/ 仅用户自建（加法）；共享护栏运行时直接读 `agents/rules`，勿拷进工作区（否则同名会盖住种子更新）
  copyTreeMissingOnly(path.join(bundleDir, WORKSPACE_RULES_DIR), wsRules, {
    skipNames: new Set(['README.md']),
  });
  fs.mkdirSync(wsRules, { recursive: true });

  copyTreeMissingOnly(
    path.join(projectRoot, PROJECT_SKILLS_STANDARD_REL),
    path.join(workspaceAbs, WORKSPACE_SKILLS_DIR)
  );

  // 工作区业务 Core（Agent 可写插件；Loader 扫描 data/ai-workspace/*/core/*/plugin）
  const coreSrc = path.join(bundleDir, 'core');
  const coreDest = path.join(workspaceAbs, 'core');
  const coreWasMissing = !fs.existsSync(coreDest);
  copyTreeMissingOnly(coreSrc, coreDest);
  if (coreWasMissing && fs.existsSync(coreDest)) {
    paths.invalidateCoreCache();
  }

  if (!fs.existsSync(path.join(workspaceAbs, AGENTS_MD))) {
    const label =
      path.basename(workspaceAbs) === DEFAULT_WORKSPACE_ID
        ? '默认工作区'
        : path.basename(workspaceAbs);
    fs.writeFileSync(
      path.join(workspaceAbs, AGENTS_MD),
      `# ${label}\n\n在此编写 Agent 规则（AGENTS.md）。\n`,
      'utf8'
    );
  }
}

/**
 * 解析 prompt 注入 / 控制台读写用的工作区绝对路径。
 * runtimeConfig.root 留空 → data/ai-workspace/{defaultId}；显式路径则相对项目根解析。
 * 落在 data/ai-workspace 下时幂等 seed（缺啥补啥）。
 */
export function resolveAgentWorkspaceAbs(cfgRoot = '') {
  let abs;
  if (cfgRoot != null && String(cfgRoot).trim() !== '') {
    const raw = String(cfgRoot).trim();
    abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(getProjectRoot(), raw);
    fs.mkdirSync(abs, { recursive: true });
  } else {
    abs = getAgentWorkspaceAbs(getConfiguredDefaultWorkspaceId());
  }
  seedWorkspaceFromBundle(abs);
  return abs;
}

export function getAgentsReadCandidates() {
  return [AGENTS_MD];
}

export function getAgentsWriteRel() {
  return AGENTS_MD;
}
