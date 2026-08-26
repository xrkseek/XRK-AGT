/**
 * 工作区上下文注入：data/ai-workspace 助手文件 + rules|skills|subagents。
 *
 * 分区顺序固定（跨请求稳定，利于 prefix cache）：
 *   1. assistant — AGENTS.md + WORKSPACE_TEMPLATE_RELS + 日更 memory + MEMORY.md
 *   2. contextFiles — agentWorkspace.contextFiles
 *   3. rules — `agents/rules`（共享直接注入）∪ 工作区 rules/（用户加法；同名覆盖）
 *   4. Skills — customSkillRoots / standard + 工作区 skills/
 *   5. Agents — `agents/subagents.yaml`（或工作区同名；OpenCode 式 mode 清单，非隔离执行）
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { realpathSyncOrResolve } from '#utils/path-guards.js';
import { readTextFileUnderWorkspaceRoot } from '#utils/safe-workspace-read.js';
import { buildSkillsPromptFromWorkspace } from '#utils/agent-workspace-skills.js';
import { DEFAULT_SKILL_LIMITS } from '#utils/skills/defaults.js';
import {
  buildTriggeredMicroagentsSection,
  extractLastUserText
} from '#utils/skills/trigger-microagents.js';
import { createHash } from 'node:crypto';
import { reconcileSystemContext } from '#utils/llm/system-context.js';
import {
  AGENTS_MD,
  AGENT_MANIFEST_BASENAMES,
  WORKSPACE_TEMPLATE_RELS,
  LONG_TERM_MEMORY_REL,
  PROJECT_RULES_DIR_REL,
  WORKSPACE_RULES_DIR,
  projectAgentsAbs,
  projectAgentsRel,
  getProjectRoot,
  resolveAgentWorkspaceAbs,
  resolveSkillRootAbsList,
} from '#utils/agent-workspace-paths.js';

/** 工作区优先，再项目根 agents/ */
const workspaceFileCache = new Map();

function formatPermissionHints(permissions) {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return '';
  const parts = [];
  for (const [k, v] of Object.entries(permissions)) {
    if (v == null || v === '') continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return parts.length ? parts.join(', ') : '';
}

function formatAgentCatalogLine(item) {
  const id = item.name || item.id || 'agent';
  const mode = String(item.mode || 'subagent').toLowerCase();
  const desc = item.description || item.prompt || item.instructions || '';
  const when = typeof item.when === 'string' ? item.when.trim() : '';
  const skills = Array.isArray(item.skills)
    ? item.skills.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    : [];
  const model = item.model != null && item.model !== '' ? String(item.model) : '';
  const perm = formatPermissionHints(item.permissions);
  const bits = [`- **${id}** [${mode}]`];
  if (model) bits[0] += ` (model: ${model})`;
  bits[0] += `: ${desc}`;
  const extras = [];
  if (when) extras.push(`何时：${when}`);
  if (skills.length) extras.push(`技能：${skills.join(', ')}`);
  if (perm) extras.push(`权限提示：${perm}`);
  if (extras.length) bits.push(`  （${extras.join('；')}）`);
  return `${bits.join('\n')}\n`;
}

/**
 * 解析 agents 清单：工作区 subagents.* 优先覆盖项目根 `agents/subagents.*`
 * @returns {{ list: object[], sourceRel: string } | null}
 */
function loadAgentCatalog(workspaceRoot, projectRoot) {
  const candidates = [];
  for (const base of AGENT_MANIFEST_BASENAMES) {
    candidates.push({ root: workspaceRoot, abs: path.join(workspaceRoot, base), rel: base });
    candidates.push({
      root: projectRoot,
      abs: projectAgentsAbs(projectRoot, base),
      rel: projectAgentsRel(base),
    });
  }

  for (const c of candidates) {
    const got = readTextFileUnderWorkspaceRootCached(c.root, c.abs, 512 * 1024);
    if (!got.ok) continue;
    try {
      const data = c.abs.endsWith('.json') ? JSON.parse(got.content) : YAML.parse(got.content);
      const list = data?.agents || data?.subagents || (Array.isArray(data) ? data : null);
      if (!Array.isArray(list) || list.length === 0) continue;
      return { list, sourceRel: c.rel };
    } catch {
      continue;
    }
  }
  return null;
}

function buildAgentsCatalogPrompt(list, maxChars) {
  const primary = [];
  const sub = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.disable === true || item.disabled === true) continue;
    const mode = String(item.mode || 'subagent').toLowerCase();
    const line = formatAgentCatalogLine(item);
    if (mode === 'primary' || mode === 'all') primary.push(line);
    else sub.push(line);
  }
  const sections = [];
  if (primary.length) {
    sections.push(`### Primary\n\n${primary.join('')}`);
  }
  if (sub.length) {
    sections.push(`### Subagents\n\n${sub.join('')}`);
  }
  if (!sections.length) return '';
  const note =
    '以下为路由提示（对齐 OpenCode mode）；**不**启动隔离子会话。按 description/when 选用技能与工具，model 字段暂不切换 LLM。\n\n';
  return truncate(note + sections.join('\n'), maxChars, 'agents-catalog');
}

function listFilesRecursive(dir, predicate) {
  const out = [];
  const walk = (cur) => {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.name === 'node_modules') continue;
      const fp = path.join(cur, e.name);
      if (e.isDirectory()) {
        walk(fp);
        continue;
      }
      if (e.isFile() && predicate(fp, e.name)) out.push(fp);
    }
  };
  walk(dir);
  return out;
}

/** @param {string} rulesDir @returns {Map<string, string>} rel → abs */
function indexRuleFiles(rulesDir) {
  const map = new Map();
  if (!rulesDir || !fs.existsSync(rulesDir)) return map;
  const absFiles = listFilesRecursive(
    rulesDir,
    (_fp, name) => name.endsWith('.md') || name.endsWith('.mdc')
  );
  for (const fp of absFiles) {
    const rel = path.relative(rulesDir, fp).replace(/\\/g, '/');
    if (!rel || rel === 'README.md') continue;
    map.set(rel, fp);
  }
  return map;
}

/**
 * 项目 `agents/rules` ∪ 工作区 rules/；工作区同名覆盖共享（工作区仅用户加法，共享不 seed 进工作区）。
 * @returns {string}
 */
function collectMergedRulesText(projectRoot, workspaceRoot, maxChars, readCached) {
  const byRel = new Map();
  for (const [rel, abs] of indexRuleFiles(path.join(projectRoot, PROJECT_RULES_DIR_REL))) {
    byRel.set(rel, { abs, root: projectRoot });
  }
  for (const [rel, abs] of indexRuleFiles(path.join(workspaceRoot, WORKSPACE_RULES_DIR))) {
    byRel.set(rel, { abs, root: workspaceRoot });
  }
  const rels = [...byRel.keys()].sort((a, b) => a.localeCompare(b));
  let acc = '';
  for (const rel of rels) {
    const { abs, root } = byRel.get(rel);
    const got = readCached(root, abs, maxChars * 4);
    if (!got.ok) continue;
    acc += `\n### ${rel}\n\n${got.content}\n`;
    if (acc.length >= maxChars) break;
  }
  return acc.trim();
}

function sliceWorkspaceCfg(aiWorkflowCfg) {
  return aiWorkflowCfg?.agentWorkspace ?? {};
}

function truncate(text, max, label) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (truncated ${label}, len=${text.length})`;
}

function readTextFileUnderWorkspaceRootCached(rootResolved, absolutePath, maxBytes) {
  let canonical;
  let st;
  try {
    canonical = realpathSyncOrResolve(absolutePath);
    st = fs.statSync(canonical);
  } catch {
    return { ok: false, reason: 'io' };
  }

  const identity = `${st.size}:${st.mtimeMs}`;
  const cached = workspaceFileCache.get(canonical);
  if (cached && cached.identity === identity) {
    return { ok: true, content: cached.content };
  }

  const got = readTextFileUnderWorkspaceRoot(rootResolved, absolutePath, maxBytes);
  if (got.ok) {
    workspaceFileCache.set(canonical, { identity, content: got.content });
  } else {
    workspaceFileCache.delete(canonical);
  }
  return got;
}

function readFirstWorkspaceFile(rootResolved, candidates, maxBytes) {
  for (const rel of candidates) {
    const fp = path.join(rootResolved, rel);
    const got = readTextFileUnderWorkspaceRootCached(rootResolved, fp, maxBytes);
    if (!got.ok) continue;
    return { rel, content: got.content };
  }
  return null;
}

function injectWorkspaceAssistant(workspaceRoot, maxChars, pushProse, { isMainSession, includeDiagnostics, maxDiagnosticsChars }) {
  const agentsGot = readFirstWorkspaceFile(workspaceRoot, [AGENTS_MD], maxChars * 4);
  if (agentsGot) {
    pushProse(agentsGot.rel, truncate(agentsGot.content, maxChars, agentsGot.rel));
  }

  for (const rel of WORKSPACE_TEMPLATE_RELS) {
    const fp = path.join(workspaceRoot, rel);
    const got = readTextFileUnderWorkspaceRootCached(workspaceRoot, fp, maxChars * 4);
    if (!got.ok) continue;
    pushProse(rel, truncate(got.content, maxChars, rel));
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  for (const ymd of [toYmd(now), toYmd(yesterday)]) {
    const rel = `memory/${ymd}.md`;
    const fp = path.join(workspaceRoot, rel);
    const got = readTextFileUnderWorkspaceRootCached(workspaceRoot, fp, maxChars * 4);
    if (!got.ok) continue;
    pushProse(rel, truncate(got.content, maxChars, rel));
  }

  if (isMainSession) {
    const memoryGot = readFirstWorkspaceFile(workspaceRoot, [LONG_TERM_MEMORY_REL], maxChars * 4);
    if (memoryGot) {
      pushProse(memoryGot.rel, truncate(memoryGot.content, maxChars, memoryGot.rel));
    } else if (includeDiagnostics) {
      const mentionsMemory = /memory\/memory\.md|memory\/\d{4}-\d{2}-\d{2}\.md/i.test(agentsGot?.content || '');
      if (!mentionsMemory) {
        const diag = [
          '未发现长期记忆文件（`memory/MEMORY.md`）。',
          '建议：在工作区 `memory/MEMORY.md` 写入长期偏好/约束，并与 `AGENTS.md` 保持一致。',
        ].join('\n');
        pushProse('Workspace diagnostics', truncate(diag, maxDiagnosticsChars, 'diagnostics'));
      }
    }
  }
}

export async function buildAgentWorkspaceSection(agentWorkspaceCfg = {}, streamName = '', opts = {}) {
  const runtimeConfig = {
    enabled: true,
    root: '',
    workflows: null,
    includeRules: true,
    includeAgentMd: true,
    includeSubagents: true,
    includeMicroagents: true,
    includeDiagnostics: false,
    maxTotalChars: 0,
    maxRulesChars: 12_000,
    maxAgentMdChars: 12_000,
    maxSubagentsChars: 4_000,
    maxMicroagentsChars: 8_000,
    maxMicroagents: 5,
    maxDiagnosticsChars: 2_000,
    maxCandidatesPerRoot: DEFAULT_SKILL_LIMITS.maxCandidatesPerRoot,
    maxSkillsLoadedPerSource: DEFAULT_SKILL_LIMITS.maxSkillsLoadedPerSource,
    maxSkillsInPrompt: DEFAULT_SKILL_LIMITS.maxSkillsInPrompt,
    maxSkillsPromptChars: DEFAULT_SKILL_LIMITS.maxSkillsPromptChars,
    maxSkillFileBytes: DEFAULT_SKILL_LIMITS.maxSkillFileBytes,
    customSkillRoots: [],
    contextFiles: [],
    ...agentWorkspaceCfg
  };

  if (runtimeConfig.enabled === false) return '';

  if (Array.isArray(runtimeConfig.workflows) && runtimeConfig.workflows.length > 0 && streamName) {
    if (!runtimeConfig.workflows.includes(streamName)) return '';
  }

  let workspaceRoot;
  let projectRoot;
  try {
    workspaceRoot = realpathSyncOrResolve(resolveAgentWorkspaceAbs(runtimeConfig.root));
    projectRoot = realpathSyncOrResolve(getProjectRoot());
    if (!fs.statSync(workspaceRoot).isDirectory()) return '';
  } catch {
    return '';
  }

  const maxProse = runtimeConfig.maxTotalChars > 0 ? runtimeConfig.maxTotalChars : Number.POSITIVE_INFINITY;
  const proseSections = [];
  let proseUsed = 0;
  const proseRoom = () => Math.max(0, maxProse - proseUsed);

  const pushProse = (title, body) => {
    if (!body?.trim()) return;
    const room = proseRoom();
    if (room <= 0) return;
    const chunk = truncate(body.trim(), room, title);
    const block = `## ${title}\n\n${chunk}`;
    proseUsed += block.length + 2;
    proseSections.push(block);
  };

  // --- 1. assistant ---
  if (runtimeConfig.includeAgentMd) {
    injectWorkspaceAssistant(workspaceRoot, runtimeConfig.maxAgentMdChars, pushProse, {
      isMainSession: streamName === 'v3' || !streamName,
      includeDiagnostics: runtimeConfig.includeDiagnostics,
      maxDiagnosticsChars: runtimeConfig.maxDiagnosticsChars
    });
  }

  // --- 2. contextFiles ---
  const extraMarkdownFiles = Array.isArray(runtimeConfig.contextFiles) ? runtimeConfig.contextFiles : [];
  for (const rel of extraMarkdownFiles) {
    if (typeof rel !== 'string' || !rel.trim()) continue;
    const safeRel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (safeRel.includes('..')) continue;
    const fp = path.join(workspaceRoot, safeRel);
    const got = readTextFileUnderWorkspaceRootCached(workspaceRoot, fp, 2 * 1024 * 1024);
    if (!got.ok) continue;
    pushProse(safeRel, got.content);
  }

  // --- 3. rules（项目共享 ∪ 工作区覆盖）---
  if (runtimeConfig.includeRules) {
    const rulesText = collectMergedRulesText(
      projectRoot,
      workspaceRoot,
      runtimeConfig.maxRulesChars,
      readTextFileUnderWorkspaceRootCached
    );
    if (rulesText) {
      pushProse('rules', truncate(rulesText, runtimeConfig.maxRulesChars, 'rules'));
    }
  }

  const parts = [...proseSections];

  // --- 4. Skills ---
  const skillRoots = resolveSkillRootAbsList({
    projectRoot,
    workspaceRoot,
    customSkillRoots: runtimeConfig.customSkillRoots,
  });
  if (skillRoots.length > 0) {
    const skillsPrompt = buildSkillsPromptFromWorkspace(projectRoot, {
      ...runtimeConfig,
      customSkillRoots: skillRoots,
    });
    if (skillsPrompt) parts.push(`## Skills\n\n${skillsPrompt}`);
  }

  // --- 5. Agents 清单（OpenCode 式 mode；提示非隔离执行）---
  if (runtimeConfig.includeSubagents) {
    const catalog = loadAgentCatalog(workspaceRoot, projectRoot);
    if (catalog) {
      const maxSub = Number(runtimeConfig.maxSubagentsChars) > 0
        ? Number(runtimeConfig.maxSubagentsChars)
        : 4_000;
      const body = buildAgentsCatalogPrompt(catalog.list, maxSub);
      if (body) parts.push(`## Agents\n\n${body}`);
    }
  }

  // --- 6. OpenHands 式 triggers microagents（命中则注入全文）---
  if (runtimeConfig.includeMicroagents !== false) {
    const userText = typeof opts.userText === 'string' ? opts.userText : '';
    if (userText.trim()) {
      const { section } = buildTriggeredMicroagentsSection({
        userText,
        maxAgents: runtimeConfig.maxMicroagents,
        maxChars: runtimeConfig.maxMicroagentsChars,
        extraRoots: runtimeConfig.customSkillRoots
      });
      if (section) parts.push(section);
    }
  }

  if (!parts.length) return '';

  // opencode SystemContext：分源指纹；未变则复用已渲染文本（稳定 prefix cache）
  const proseText = proseSections.join('\n\n');
  const restParts = parts.slice(proseSections.length);
  const sources = [];
  if (proseText) {
    sources.push({
      key: 'workspace/prose',
      fingerprint: createHash('sha256').update(proseText).digest('hex'),
      text: proseText
    });
  }
  for (let i = 0; i < restParts.length; i++) {
    const t = restParts[i];
    sources.push({
      key: `workspace/part/${i}`,
      fingerprint: createHash('sha256').update(t).digest('hex'),
      text: t
    });
  }
  const sessionKey = `ws:${streamName || 'default'}:${workspaceRoot}`;
  const { text: body } = reconcileSystemContext(sessionKey, sources);
  return `\n\n---\n\n# Workspace context\n\n${body}\n`;
}

export async function appendAgentWorkspaceToPrompt(basePrompt, aiWorkflowCfg = {}, streamName = '', opts = {}) {
  if (basePrompt == null) return basePrompt;
  const extra = await buildAgentWorkspaceSection(sliceWorkspaceCfg(aiWorkflowCfg), streamName, opts);
  if (!extra) return String(basePrompt);
  return `${basePrompt}${extra}`;
}

export async function mergeAgentWorkspaceIntoMessages(messages, aiWorkflowCfg = {}, streamName = '') {
  if (!Array.isArray(messages)) return messages;
  const userText = extractLastUserText(messages);
  const extra = await buildAgentWorkspaceSection(sliceWorkspaceCfg(aiWorkflowCfg), streamName, { userText });
  if (!extra) return messages;
  const first = messages[0];
  if (first?.role === 'system' && typeof first.content === 'string') {
    first.content = `${first.content}${extra}`;
    return messages;
  }
  messages.unshift({ role: 'system', content: extra.replace(/^\s+/, '') });
  return messages;
}
