/**
 * 项目托管技能（`.xrk/skills` 有对应包）：
 * - seed：缺啥补啥
 * - #skills更新：托管包按种子覆盖；用户自建（种子无包）永不碰
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  PROJECT_SKILLS_STANDARD_REL,
  WORKSPACE_SKILLS_DIR,
  getProjectRoot,
  resolveAgentWorkspaceAbs,
} from '#utils/agent-workspace-paths.js';

const LOCK_REL = path.join('.xrk', 'managed-skills-lock.json');

/** @param {string} dir @param {string[]} outRels @param {string} base */
function walkSkillPackages(dir, outRels, base) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
    outRels.push(path.relative(base, dir).replace(/\\/g, '/'));
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (!e.isDirectory()) continue;
    walkSkillPackages(path.join(dir, e.name), outRels, base);
  }
}

/** 种子内技能包相对路径，如 core/agent-tools */
export function listProjectManagedSkillRels(projectRoot = getProjectRoot()) {
  const standard = path.join(projectRoot, PROJECT_SKILLS_STANDARD_REL);
  const out = [];
  if (!fs.existsSync(standard)) return out;
  walkSkillPackages(standard, out, standard);
  return out.sort((a, b) => a.localeCompare(b));
}

function listFilesRecursive(dir) {
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
      const fp = path.join(cur, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.isFile()) out.push(fp);
    }
  };
  walk(dir);
  return out;
}

/** 目录内容指纹（路径相对 dir，排序后哈希） */
function hashSkillPackageDir(dirAbs) {
  if (!fs.existsSync(dirAbs)) return '';
  const files = listFilesRecursive(dirAbs)
    .map((fp) => path.relative(dirAbs, fp).replace(/\\/g, '/'))
    .sort((a, b) => a.localeCompare(b));
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(dirAbs, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

function lockPath(workspaceAbs) {
  return path.join(workspaceAbs, LOCK_REL);
}

function readLock(workspaceAbs) {
  const fp = lockPath(workspaceAbs);
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const packages = raw?.packages && typeof raw.packages === 'object' ? raw.packages : {};
    return { packages };
  } catch {
    return { packages: {} };
  }
}

function writeLock(workspaceAbs, lock) {
  const fp = lockPath(workspaceAbs);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(
    fp,
    `${JSON.stringify({ version: 1, packages: lock.packages, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  );
}

function copyDirOverwrite(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * 托管包按种子覆盖；种子中不存在的工作区技能（用户自建）不碰。
 * @param {string} [workspaceAbs]
 */
export function syncManagedSkills(workspaceAbs) {
  const ws =
    workspaceAbs && String(workspaceAbs).trim()
      ? path.normalize(workspaceAbs)
      : resolveAgentWorkspaceAbs();
  const projectRoot = getProjectRoot();
  const standard = path.join(projectRoot, PROJECT_SKILLS_STANDARD_REL);
  if (!fs.existsSync(standard)) {
    return { ok: false, error: `种子不存在：${PROJECT_SKILLS_STANDARD_REL}` };
  }

  const destRoot = path.join(ws, WORKSPACE_SKILLS_DIR);
  fs.mkdirSync(destRoot, { recursive: true });
  const lock = readLock(ws);
  const pkgs = listProjectManagedSkillRels(projectRoot);

  const updated = [];
  const unchanged = [];
  const installed = [];

  for (const rel of pkgs) {
    const src = path.join(standard, rel);
    const dest = path.join(destRoot, rel);
    const seedHash = hashSkillPackageDir(src);

    try {
      if (!fs.existsSync(dest)) {
        copyDirOverwrite(src, dest);
        lock.packages[rel] = { seedHash, syncedAt: new Date().toISOString() };
        installed.push(rel);
        continue;
      }

      const wsHash = hashSkillPackageDir(dest);
      if (wsHash === seedHash) {
        lock.packages[rel] = { seedHash, syncedAt: new Date().toISOString() };
        unchanged.push(rel);
      } else {
        copyDirOverwrite(src, dest);
        lock.packages[rel] = { seedHash, syncedAt: new Date().toISOString() };
        updated.push(rel);
      }
    } catch (err) {
      return {
        ok: false,
        error: `同步失败 ${rel}: ${err?.message || err}`,
        updated,
        installed,
        unchanged,
      };
    }
  }

  writeLock(ws, lock);
  return {
    ok: true,
    updated,
    installed,
    unchanged,
    hint: '已按种子覆盖托管包；种子中不存在的工作区技能（用户自建）未改动。',
  };
}
