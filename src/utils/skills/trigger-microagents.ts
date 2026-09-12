/**
 * 触发式知识注入（对齐 OpenHands microagents / skills triggers）。
 * 扫描工作区与项目根下带 frontmatter triggers 的 Markdown，
 * 用户文本命中时把正文整段注入 prompt（非仅目录名）。
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getProjectRoot, PROJECT_MICROAGENTS_DIR_REL, PROJECT_SKILLS_STANDARD_REL, resolveAgentWorkspaceAbs } from '#utils/agent-workspace-paths.js';
import { isPathInside, realpathSyncOrResolve } from '#utils/path-guards.js';

const REL_ROOTS = [PROJECT_MICROAGENTS_DIR_REL, PROJECT_SKILLS_STANDARD_REL];

type FrontmatterMeta = Record<string, unknown>;

type ParsedFrontmatter = {
  meta: FrontmatterMeta;
  body: string;
};

type AgentDoc = {
  name: string;
  triggers: string[];
  body: string;
  path: string;
};

type BuildTriggeredMicroagentsOpts = {
  userText?: string;
  maxAgents?: number;
  maxChars?: number;
  extraRoots?: string[];
};

type BuildTriggeredMicroagentsResult = {
  section: string;
  activated: string[];
};

type MessageContentPart = {
  text?: string;
  [key: string]: unknown;
};

type ChatMessageLike = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

export function parseMarkdownFrontmatter(raw: unknown): ParsedFrontmatter | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  try {
    const meta = YAML.parse(m[1]) || {};
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    return { meta: meta as FrontmatterMeta, body: m[2] || '' };
  } catch {
    return null;
  }
}

function normalizeTriggers(triggers: unknown): string[] {
  if (Array.isArray(triggers)) {
    return triggers.map((t) => String(t || '').trim()).filter(Boolean);
  }
  if (typeof triggers === 'string' && triggers.trim()) return [triggers.trim()];
  return [];
}

function triggerMatches(userText: unknown, trigger: unknown): boolean {
  const t = String(trigger || '').trim();
  if (!t) return false;
  const text = String(userText || '');
  if (!text) return false;
  // 斜杠命令：整词/前缀
  if (t.startsWith('/')) {
    const re = new RegExp(`(?:^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|\\s|$)`, 'i');
    return re.test(text) || text.trimStart().toLowerCase().startsWith(t.toLowerCase());
  }
  // 关键词：大小写不敏感子串
  return text.toLowerCase().includes(t.toLowerCase());
}

function listMdFiles(dir: string, maxFiles = 80): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (out.length >= maxFiles || depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) break;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue;
        walk(abs, depth + 1);
        continue;
      }
      if (/\.(md|mdc)$/i.test(ent.name)) out.push(abs);
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * 额外扫描 skills 树中带 triggers 的 SKILL.md（OpenHands 式）。
 */
function listSkillMdWithTriggersHint(root: string, max = 120): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (out.length >= max || depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= max) break;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        walk(abs, depth + 1);
        continue;
      }
      if (ent.name === 'SKILL.md' || ent.name === 'skill.md') out.push(abs);
    }
  };
  walk(root, 0);
  return out;
}

function loadAgentDoc(absFile: string, rootReal: string): AgentDoc | null {
  const real = realpathSyncOrResolve(absFile);
  if (!isPathInside(rootReal, real)) return null;
  let raw: string;
  try {
    const st = fs.statSync(real);
    if (st.size > 256_000) return null;
    raw = fs.readFileSync(real, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseMarkdownFrontmatter(raw);
  if (!parsed) return null;
  const triggers = normalizeTriggers(parsed.meta.triggers);
  if (!triggers.length) return null;
  const name = String(parsed.meta.name || path.basename(path.dirname(real)) || path.basename(real, '.md'));
  const body = String(parsed.body || '').trim();
  if (!body) return null;
  return { name, triggers, body, path: real };
}

export function buildTriggeredMicroagentsSection(
  opts: BuildTriggeredMicroagentsOpts = {},
): BuildTriggeredMicroagentsResult {
  const userText = String(opts.userText || '');
  if (!userText.trim()) return { section: '', activated: [] };

  const maxAgents = Math.max(1, Number(opts.maxAgents) || 5);
  const maxChars = Math.max(500, Number(opts.maxChars) || 12_000);
  const projectRoot = getProjectRoot();
  const workspaceRoot = resolveAgentWorkspaceAbs();
  const roots = new Set<string>();

  for (const base of [workspaceRoot, projectRoot]) {
    if (!base) continue;
    for (const rel of REL_ROOTS) {
      roots.add(path.join(base, rel));
    }
  }
  for (const r of opts.extraRoots || []) {
    if (typeof r === 'string' && r.trim()) {
      roots.add(path.isAbsolute(r) ? r : path.join(projectRoot, r));
    }
  }

  const catalog = new Map<string, AgentDoc>();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let rootReal: string;
    try {
      rootReal = realpathSyncOrResolve(root);
      if (!fs.statSync(rootReal).isDirectory()) continue;
    } catch {
      continue;
    }
    const files = [
      ...listMdFiles(rootReal, 60),
      ...listSkillMdWithTriggersHint(rootReal, 80)
    ];
    for (const f of files) {
      const doc = loadAgentDoc(f, rootReal);
      if (!doc) continue;
      if (!catalog.has(doc.name)) catalog.set(doc.name, doc);
    }
  }

  const activated: string[] = [];
  const chunks: string[] = [];
  let used = 0;
  for (const doc of catalog.values()) {
    if (activated.length >= maxAgents) break;
    const hit = doc.triggers.some((t) => triggerMatches(userText, t));
    if (!hit) continue;
    const block = `### ${doc.name}\n\n${doc.body}\n`;
    if (used + block.length > maxChars && activated.length > 0) break;
    chunks.push(block);
    activated.push(doc.name);
    used += block.length;
  }

  if (!activated.length) return { section: '', activated: [] };
  const section =
    `## Activated microagents\n\n`
    + `（OpenHands 式 triggers 命中：${activated.join(', ')}）\n\n`
    + chunks.join('\n');
  return { section, activated };
}

/**
 * 从 messages 取最后一条用户文本。
 */
export function extractLastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessageLike | undefined;
    if (!m || (m.role || '').toLowerCase() !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((p) => (typeof p === 'string' ? p : (p as MessageContentPart)?.text || '')).join('\n');
    }
    if (c && typeof c === 'object' && typeof (c as MessageContentPart).text === 'string') {
      return (c as MessageContentPart).text!;
    }
  }
  return '';
}
