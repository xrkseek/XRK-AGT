import fs from 'node:fs/promises';
import path from 'node:path';
import paths from '#utils/paths.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';

const MAX_AUDIT_BYTES = 512_000;

function isAuditEnabled() {
  const runtimeConfig = getAiWorkflowConfigOptional();
  return runtimeConfig?.workspace?.audit?.enabled !== false;
}

function getAuditMaxEntries() {
  const runtimeConfig = getAiWorkflowConfigOptional();
  const n = Number(runtimeConfig?.workspace?.audit?.maxEntries);
  if (Number.isFinite(n) && n >= 10) return Math.min(500, Math.floor(n));
  return 200;
}
const AUDIT_DIR = path.join(paths.data, 'ai-console', 'audit');

function auditFileForWorkspace(workspaceId: any) {
  const safe = String(workspaceId || 'default').replace(/[^\w.-]/g, '_').slice(0, 64);
  return path.join(AUDIT_DIR, `${safe}.jsonl`);
}

export function formatAuditDetail(detail: any) {
  const s = String(detail || '').trim();
  if (!s) return '';
  if (/pandoc:\s*not found/i.test(s)) return 'pandoc 未安装';
  if (/soffice:\s*not found/i.test(s)) return 'LibreOffice 未安装';
  if (/Command failed:/i.test(s)) {
    const tail = s.replace(/^Command failed:\s*/i, '').replace(/\s+/g, ' ').trim();
    return tail.length > 180 ? `${tail.slice(0, 180)}…` : tail;
  }
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

export async function auditToolUse(workspaceId: any, tool: any, { ok = true, detail = '' }: any = {}) {
  if (!isAuditEnabled() || !workspaceId || !tool) return;
  const file = auditFileForWorkspace(workspaceId);
  const line = `${JSON.stringify({
    ts: Date.now(),
    tool: String(tool),
    ok: ok !== false,
    detail: formatAuditDetail(detail)
  })}\n`;
  try {
    await fs.mkdir(AUDIT_DIR, { recursive: true });
    await fs.appendFile(file, line, 'utf8');
    const st = await fs.stat(file);
    if (st.size > MAX_AUDIT_BYTES) {
      const raw = await fs.readFile(file, 'utf8');
      const lines = raw.trim().split('\n');
      await fs.writeFile(file, `${lines.slice(-getAuditMaxEntries()).join('\n')}\n`, 'utf8');
    }
  } catch { /* 审计失败不阻断 */ }
}

export async function readAuditTail(workspaceId: any, limit: any = 50) {
  const file = auditFileForWorkspace(workspaceId);
  const cap = Math.min(200, Math.max(1, limit));
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw.trim().split('\n').filter(Boolean).slice(-cap).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}
