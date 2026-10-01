/**
 * goose Recipe 可移植核：YAML/JSON 配方（instructions + prompt + parameters）。
 * 目录：`agents/recipes/`、工作区 recipes/、~/.xrk/recipes/
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { getProjectRoot, projectAgentsAbs, resolveAgentWorkspaceAbs } from '#utils/agent-workspace-paths.js';

export type RecipeParameter = {
  name: string;
  description?: string;
  default?: string;
  required?: boolean;
};

export type Recipe = {
  id: string;
  title?: string;
  description?: string;
  instructions?: string;
  prompt?: string;
  parameters?: RecipeParameter[];
  cron?: string;
  skills?: string[];
  path: string;
};

type RecipeFileData = Record<string, unknown>;

type MaterializeRecipeResult = {
  systemExtra: string;
  userPrompt: string;
  params: Record<string, string>;
};

function asRecord(value: unknown): RecipeFileData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RecipeFileData;
}

function parseRecipeFile(absPath: string): Recipe | null {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = absPath.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(data);
  if (!record) return null;
  const id = String(record.id || record.name || path.basename(absPath, path.extname(absPath))).trim();
  if (!id) return null;
  if (!record.instructions && !record.prompt) return null;
  return {
    id,
    title: String(record.title || id),
    description: String(record.description || ''),
    instructions: String(record.instructions || ''),
    prompt: String(record.prompt || ''),
    parameters: Array.isArray(record.parameters) ? record.parameters as RecipeParameter[] : [],
    cron: typeof record.cron === 'string' ? record.cron.trim() : '',
    skills: Array.isArray(record.skills) ? record.skills.map(String) : [],
    path: absPath
  };
}

function listRecipeFiles(dir: string | null | undefined, max = 80): string[] {
  const out: string[] = [];
  if (!dir || !fs.existsSync(dir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (out.length >= max) break;
    if (!ent.isFile()) continue;
    if (!/\.(ya?ml|json)$/i.test(ent.name)) continue;
    out.push(path.join(dir, ent.name));
  }
  return out;
}

export function listRecipes(): Recipe[] {
  const roots = [
    projectAgentsAbs(getProjectRoot(), 'recipes'),
    path.join(resolveAgentWorkspaceAbs(), 'recipes'),
    path.join(os.homedir(), '.xrk', 'recipes')
  ];
  const map = new Map<string, Recipe>();
  for (const root of roots) {
    for (const file of listRecipeFiles(root)) {
      const r = parseRecipeFile(file);
      if (!r) continue;
      if (!map.has(r.id)) map.set(r.id, r);
    }
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getRecipe(id: unknown): Recipe | null {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return null;
  return listRecipes().find((r) => r.id.toLowerCase() === key) || null;
}

export function renderRecipeTemplate(
  template: unknown,
  params: Record<string, string> = {},
): string {
  let s = String(template || '');
  for (const [k, v] of Object.entries(params)) {
    const re = new RegExp(`\\{\\{\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g');
    s = s.replace(re, String(v ?? ''));
  }
  // 未替换的必填占位保留原样
  return s;
}

export function materializeRecipe(
  recipe: Recipe,
  params: Record<string, string> = {},
): MaterializeRecipeResult {
  const merged: Record<string, string> = { ...params };
  for (const p of recipe.parameters || []) {
    const name = String(p.name || '').trim();
    if (!name) continue;
    if (merged[name] == null || merged[name] === '') {
      if (p.default != null) merged[name] = String(p.default);
    }
  }
  const systemExtra = renderRecipeTemplate(recipe.instructions || '', merged).trim();
  const userPrompt = renderRecipeTemplate(recipe.prompt || '', merged).trim();
  return { systemExtra, userPrompt, params: merged };
}
