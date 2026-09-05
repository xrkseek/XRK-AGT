// @ts-nocheck
import { AsyncLocalStorage } from 'node:async_hooks';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { auditToolUse, formatAuditDetail } from './ai-workspace-audit.js';
import { normalizePresetId } from './ai-workspace-runtime.js';

const consoleContext = new AsyncLocalStorage();
let mcpAuditHookInstalled = false;

function normalizeWorkspaceId(id) {
  return normalizePresetId(id);
}

function isAuditEnabled() {
  const runtimeConfig = getAiWorkflowConfigOptional();
  return runtimeConfig?.workspace?.audit?.enabled !== false;
}

async function recordToolAudit(toolName, { ok = true, detail = '' } = {}) {
  if (!isAuditEnabled()) return;
  const ctx = getAiConsoleContext();
  const workspaceId = ctx.workspaceId;
  if (!workspaceId || !toolName) return;

  const formatted = formatAuditDetail(detail);
  try {
    await auditToolUse(workspaceId, toolName, { ok, detail: formatted });
  } catch { /* 审计失败不阻断 */ }
}

/**
 * 包装 MCPServer.handleToolCall，在工作区上下文中记录工具审计。
 * MCP 尚未挂载时返回 false，调用方可稍后重试。
 */
export function installMcpAuditHook() {
  if (mcpAuditHookInstalled) return true;

  const server = AiWorkflowLoader.mcpServer;
  if (!server || typeof server.handleToolCall !== 'function') return false;

  const original = server.handleToolCall.bind(server);
  server.handleToolCall = async (request) => {
    const toolName = request?.name;
    try {
      const result = await original(request);
      if (toolName) {
        const ok = !result?.isError;
        const detail = ok ? '' : (result?.content?.[0]?.text || '');
        await recordToolAudit(toolName, { ok, detail });
      }
      return result;
    } catch (err) {
      if (toolName) {
        await recordToolAudit(toolName, { ok: false, detail: err?.message || String(err) });
      }
      throw err;
    }
  };

  mcpAuditHookInstalled = true;
  return true;
}

export function runWithAiConsoleContext(ctx = {}, fn) {
  const parent = consoleContext.getStore() || {};
  const next = { ...parent, ...ctx };
  return consoleContext.run(next, fn);
}

export function getAiConsoleContext() {
  return consoleContext.getStore() || {};
}

