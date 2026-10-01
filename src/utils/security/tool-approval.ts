/**
 * 工具审批队列（goose RequireApproval 通道适配）。
 * 默认关闭（security.approval.enabled=false）：ask 直接拒绝。
 * 开启后私聊主人；`#批准` / `#批准id` / `#批准 id`（空格可选）。
 */
import { randomUUID } from 'node:crypto';
import runtimeConfig from '#infrastructure/config/config.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import RuntimeUtil from '#utils/runtime-util.js';
import MonitorService from '#infrastructure/ai-workflow/monitor-service.js';
import { normalizeError } from '#utils/normalize-error.js';

type ApprovalDecision = 'allow' | 'deny';

type ApprovalMeta = {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  findings?: unknown[];
  id?: string;
};

type PendingEntry = {
  resolve: (decision: ApprovalDecision) => void;
  meta: ApprovalMeta & { id: string };
  timer: ReturnType<typeof setTimeout>;
};

/** 模块级队列：勿放进 class constructor */
const pending = new Map<string, PendingEntry>();

type ApprovalCfg = {
  enabled: boolean;
  timeoutMs: number;
};

function cfg(): ApprovalCfg {
  const raw =
    (
      getAiWorkflowConfigOptional() as
        | { security?: { approval?: Record<string, unknown> } }
        | null
        | undefined
    )?.security?.approval ?? {};
  return {
    enabled: raw.enabled === true,
    timeoutMs: typeof raw.timeoutMs === 'number' ? Math.max(5000, raw.timeoutMs) : 180_000,
  };
}

/** 是否开启交互审批（默认关） */
export function isToolApprovalEnabled(): boolean {
  return cfg().enabled;
}

type AgentRuntimeGlobal = {
  uin?: Iterable<unknown> | unknown[];
  sendFriendMsg?: (botId: string, qq: string, text: string) => Promise<unknown> | unknown;
};

async function notifyMasters(text: string): Promise<boolean> {
  const masters = ((runtimeConfig as { masterQQ?: unknown[] }).masterQQ || [])
    .map(String)
    .filter(Boolean);
  const runtime = (globalThis as typeof globalThis & { AgentRuntime?: AgentRuntimeGlobal })
    .AgentRuntime;
  const botIds = (Array.isArray(runtime?.uin) ? [...runtime.uin] : [])
    .map(String)
    .filter((id) => id && id !== 'stdin');
  if (!masters.length || !botIds.length) return false;
  let sent = false;
  for (const botId of botIds) {
    for (const qq of masters) {
      try {
        await runtime?.sendFriendMsg?.(botId, qq, text);
        sent = true;
      } catch (err: unknown) {
        RuntimeUtil.makeLog(
          'warn',
          `[tool-approval] 通知主人失败 ${botId}/${qq}: ${normalizeError(err).message}`,
          'ToolApproval',
        );
      }
    }
  }
  return sent;
}

/**
 * 从主人消息解析编号。支持：`#批准` / `#批准ab12` / `#批准 ab12` / `#approve ab12`
 */
export function parseApprovalCommand(
  msg: unknown,
  decision: ApprovalDecision,
): { decision: ApprovalDecision; id: string } | null {
  const s = String(msg || '').trim();
  const allowRe = /^#(批准|approve)\s*([A-Za-z0-9_-]*)\s*$/i;
  const denyRe = /^#(拒绝|deny)\s*([A-Za-z0-9_-]*)\s*$/i;
  const m = decision === 'allow' ? s.match(allowRe) : s.match(denyRe);
  if (!m) return null;
  return { decision, id: String(m[2] || '').trim() };
}

export async function requestToolApproval(meta: ApprovalMeta): Promise<ApprovalDecision> {
  const { enabled, timeoutMs } = cfg();
  if (!enabled) return 'deny';

  const id = randomUUID().slice(0, 8);
  const argPreview = (() => {
    try {
      const s = JSON.stringify(meta.args ?? {});
      return s.length > 400 ? `${s.slice(0, 400)}…` : s;
    } catch {
      return '{}';
    }
  })();

  const msg = [
    '【危险指令待审批】',
    `编号：${id}`,
    `工具：${meta.toolName}`,
    `原因：${meta.reason}`,
    `参数：${argPreview}`,
    '',
    `批准：#批准${id}  或  #批准 ${id}  或仅一条时发 #批准`,
    `拒绝：#拒绝${id}  或  #拒绝 ${id}`,
  ].join('\n');

  MonitorService.emit('tool:approval_requested', { id, ...meta });

  const notified = await notifyMasters(msg);
  if (!notified) {
    RuntimeUtil.makeLog('warn', `[tool-approval] 无法通知主人，按拒绝: ${id}`, 'ToolApproval');
    return 'deny';
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      RuntimeUtil.makeLog('warn', `[tool-approval] 超时拒绝: ${id}`, 'ToolApproval');
      MonitorService.emit('tool:approval_timeout', { id });
      resolve('deny');
    }, timeoutMs);
    pending.set(id, {
      resolve: (decision: ApprovalDecision) => {
        clearTimeout(timer);
        pending.delete(id);
        MonitorService.emit('tool:approval_resolved', { id, decision });
        resolve(decision);
      },
      meta: { ...meta, id },
      timer,
    });
  });
}

/**
 * @param id 空=仅当队列恰好 1 条时批/拒该条
 */
export function resolveToolApproval(
  id: unknown,
  decision: ApprovalDecision,
): { ok: boolean; id?: string; error?: string } {
  const key = String(id || '').trim();
  let entry: PendingEntry | undefined;
  let resolvedId = key;

  if (key) {
    entry = pending.get(key);
    if (!entry) return { ok: false, error: `未找到待审批 ${key}` };
  } else {
    if (pending.size === 0) return { ok: false, error: '当前无待审批' };
    if (pending.size > 1) {
      return {
        ok: false,
        error: `有 ${pending.size} 条待审批，请带编号：#批准<编号>`,
      };
    }
    const [[onlyId, onlyEntry]] = pending.entries();
    entry = onlyEntry;
    resolvedId = onlyId!;
  }

  clearTimeout(entry.timer);
  entry.resolve(decision === 'allow' ? 'allow' : 'deny');
  return { ok: true, id: resolvedId };
}

export function listPendingApprovals(): Array<ApprovalMeta & { id: string }> {
  return [...pending.values()].map((p) => p.meta);
}
