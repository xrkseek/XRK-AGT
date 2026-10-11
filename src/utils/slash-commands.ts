/**
 * 斜杠命令（对齐 goose skill slash + recipe）。
 * /recipes · /recipe <id> [k=v ...] · /skills · /<skillName> [args]
 */
import fs from 'node:fs';
import path from 'node:path';
import { getProjectRoot, resolveAgentWorkspaceAbs } from '#utils/agent-workspace-paths.js';
import { getRecipe, listRecipes, materializeRecipe } from '#utils/recipes/recipe-loader.js';
import { parseMarkdownFrontmatter } from '#utils/skills/trigger-microagents.js';

export function parseSlashLine(text: unknown): { command: string; rest: string } | null {
  const s = String(text || '').trim();
  if (!s.startsWith('/')) return null;
  const m = s.match(/^\/([A-Za-z0-9_\-.]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { command: m[1]!, rest: (m[2] || '').trim() };
}

export function parseKvArgs(rest: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const s = String(rest || '').trim();
  if (!s) return out;
  // k=v 或 k="v v"
  const re = /([A-Za-z_][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    out[m[1]!] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  if (!matched) out._ = s;
  return out;
}

function findSkillMdByName(name: string): { name: string; body: string; path: string } | null {
  const want = String(name || '').toLowerCase();
  const roots = [
    path.join(getProjectRoot(), 'agents', 'skills'),
    path.join(resolveAgentWorkspaceAbs(), 'skills'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
          stack.push(abs);
          continue;
        }
        if (ent.name !== 'SKILL.md' && ent.name !== 'skill.md') continue;
        const folder = path.basename(dir).toLowerCase();
        let raw = '';
        try {
          raw = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const fm = parseMarkdownFrontmatter(raw) as {
          meta?: { name?: string };
          body?: string;
        } | null;
        const id = String(fm?.meta?.name || folder).toLowerCase();
        if (id === want || folder === want) {
          return {
            name: fm?.meta?.name || folder,
            body: (fm?.body || raw).trim(),
            path: abs,
          };
        }
      }
    }
  }
  return null;
}

export type SlashCommandResult = {
  handled: boolean;
  kind?: string;
  text?: string;
  systemExtra?: string;
  replyOnly?: string;
};

export function resolveSlashCommand(userText: unknown): SlashCommandResult {
  const parsed = parseSlashLine(userText);
  if (!parsed) return { handled: false };

  const cmd = parsed.command.toLowerCase();
  const rest = parsed.rest;

  if (cmd === 'recipes' || cmd === 'recipe-list') {
    const list = listRecipes();
    if (!list.length) {
      return { handled: true, replyOnly: '暂无配方。可在 agents/recipes/*.yaml 添加。' };
    }
    const lines = list.map(
      (r) =>
        `- **${r.id}**：${r.title}${r.description ? ` — ${r.description}` : ''}${r.cron ? ` \`cron:${r.cron}\`` : ''}`,
    );
    return {
      handled: true,
      replyOnly: `可用配方：\n${lines.join('\n')}\n\n用法：\`/recipe <id> [k=v]\``,
    };
  }

  if (cmd === 'recipe' || cmd === 'r') {
    const [id, ...argParts] = rest.split(/\s+/);
    if (!id) {
      return { handled: true, replyOnly: '用法：`/recipe <id> [param=value]`；列表：`/recipes`' };
    }
    const recipe = getRecipe(id);
    if (!recipe) {
      return { handled: true, replyOnly: `未找到配方：${id}。\`/recipes\` 查看列表。` };
    }
    const params = parseKvArgs(argParts.join(' '));
    const { systemExtra, userPrompt } = materializeRecipe(recipe, params);
    const text = userPrompt || `请按配方「${recipe.title}」执行。`;
    return {
      handled: true,
      kind: 'recipe',
      text,
      systemExtra: systemExtra
        ? `## Recipe: ${recipe.title}\n\n${systemExtra}`
        : `## Recipe: ${recipe.title}`,
    };
  }

  if (cmd === 'skills' || cmd === 'skill-list') {
    return {
      handled: true,
      replyOnly: '技能见 Workspace context 的 Skills 目录；或 `/<skill名>` 直接注入全文。',
    };
  }

  // /<skillName> [args]
  const skill = findSkillMdByName(cmd);
  if (skill) {
    const argsNote = rest ? `\n\n（用户参数：${rest}）` : '';
    return {
      handled: true,
      kind: 'skill',
      text: rest || `请按技能「${skill.name}」执行。`,
      systemExtra: `## Activated skill: ${skill.name}\n\n${skill.body}${argsNote}`,
    };
  }

  return { handled: false };
}
