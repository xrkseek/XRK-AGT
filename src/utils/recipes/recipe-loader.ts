/**
 * goose Recipe 可移植核：YAML/JSON 配方（instructions + prompt + parameters）。
 * 目录：`agents/recipes/`、工作区 recipes/、~/.xrk/recipes/
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { getProjectRoot, projectAgentsAbs, resolveAgentWorkspaceAbs } from '#utils/agent-workspace-paths.js';

/**
 * @typedef {{
 *   id: string,
 *   title?: string,
 *   description?: string,
 *   instructions?: string,
 *   prompt?: string,
 *   parameters?: Array<{ name: string, description?: string, default?: string, required?: boolean }>,
 *   cron?: string,
 *   skills?: string[],
 *   path: string
 * }} Recipe
 */

function parseRecipeFile(absPath: any) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = absPath.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const id = String(data.id || data.name || path.basename(absPath, path.extname(absPath))).trim();
  if (!id) return null;
  if (!data.instructions && !data.prompt) return null;
  return {
    id,
    title: data.title || id,
    description: data.description || '',
    instructions: data.instructions || '',
    prompt: data.prompt || '',
    parameters: Array.isArray(data.parameters) ? data.parameters : [],
    cron: typeof data.cron === 'string' ? data.cron.trim() : '',
    skills: Array.isArray(data.skills) ? data.skills.map(String) : [],
    path: absPath
  };
}

function listRecipeFiles(dir: any, max = 80) {
  const out: any[] = [];
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

/** @returns {Recipe[]} */
export function listRecipes(): any[] {
  const roots = [
    projectAgentsAbs(getProjectRoot(), 'recipes'),
    path.join(resolveAgentWorkspaceAbs(), 'recipes'),
    path.join(os.homedir(), '.xrk', 'recipes')
  ];
  /** @type {Map<string, Recipe>} */
  const map = new Map();
  for (const root of roots) {
    for (const file of listRecipeFiles(root)) {
      const r = parseRecipeFile(file);
      if (!r) continue;
      if (!map.has(r.id)) map.set(r.id, r);
    }
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** @param {string} id */
export function getRecipe(id: any) {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return null;
  return listRecipes().find((r) => r.id.toLowerCase() === key) || null;
}

/**
 * @param {string} template
 * @param {Record<string, string>} params
 */
export function renderRecipeTemplate(template: any, params: any = {}) {
  let s = String(template || '');
  for (const [k, v] of Object.entries(params)) {
    const re = new RegExp(`\\{\\{\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g');
    s = s.replace(re, String(v ?? ''));
  }
  // 未替换的必填占位保留原样
  return s;
}

/**
 * @param {Recipe} recipe
 * @param {Record<string, string>} [params]
 * @returns {{ systemExtra: string, userPrompt: string }}
 */
export function materializeRecipe(recipe: any, params: any = {}) {
  const merged = { ...params };
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
