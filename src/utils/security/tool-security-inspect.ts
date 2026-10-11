/**
 * 工具调用安全检查（goose ToolInspection + SecurityManager 可移植核）。
 * 调用点：`MCPServer.handleToolCall`（统一覆盖 LLM / HTTP / WS / JSON-RPC）。
 * 顺序：policies（tool.call allow|deny|ask）→ toolScan 模式匹配 → ask 时主人旁路或 interactive approval。
 */
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { getWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js';
import { checkToolCallAllowed } from '#utils/runtime-policy.js';
import {
  maxRisk,
  scanTextForThreats,
  type RiskLevel,
  type ThreatPattern,
} from '#utils/security/tool-threat-patterns.js';
import { requestToolApproval } from '#utils/security/tool-approval.js';
import RuntimeUtil from '#utils/runtime-util.js';

type ScanAction = 'allow' | 'ask' | 'deny';

type ToolScanCfg = {
  enabled: boolean;
  onCritical: 'ask' | 'deny';
  onHigh: ScanAction;
  onMedium: ScanAction;
  masterBypassAsk: boolean;
  interactiveApproval: boolean;
  scanFullArgs: boolean;
  argKeys: string[];
};

type SecurityResult = {
  ok: boolean;
  error?: string;
  warnings?: string[];
  findings?: ThreatPattern[];
};

type FindingLike = {
  risk: RiskLevel;
  name: string;
  description: string;
};

function asAction(v: unknown, fallback: ScanAction): ScanAction {
  return v === 'deny' || v === 'ask' || v === 'allow' ? v : fallback;
}

function getSecurityCfg(): ToolScanCfg {
  const root = getAiWorkflowConfigOptional() as
    | {
        security?: {
          toolScan?: Record<string, unknown>;
          approval?: Record<string, unknown>;
        };
      }
    | null
    | undefined;
  const raw = root?.security?.toolScan ?? {};
  const approval = root?.security?.approval ?? {};
  return {
    enabled: raw.enabled !== false,
    onCritical: raw.onCritical === 'ask' ? 'ask' : 'deny',
    onHigh: asAction(raw.onHigh, 'ask'),
    onMedium: asAction(raw.onMedium, 'allow'),
    masterBypassAsk: raw.masterBypassAsk !== false,
    interactiveApproval: approval.enabled === true,
    scanFullArgs: raw.scanFullArgs === true,
    argKeys:
      Array.isArray(raw.argKeys) && raw.argKeys.length
        ? raw.argKeys.map(String)
        : ['command', 'cmd', 'script', 'code', 'shell', 'powershell'],
  };
}

function isMasterRequester(): boolean {
  const e = (getWorkflowRequestContext() as { e?: { isMaster?: boolean } } | null | undefined)?.e;
  return e?.isMaster === true;
}

function collectScanText(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  const cfg = getSecurityCfg();
  const parts: string[] = [];
  if (typeof args === 'object' && !Array.isArray(args)) {
    const obj = args as Record<string, unknown>;
    for (const k of cfg.argKeys) {
      if (obj[k] != null) parts.push(String(obj[k]));
    }
  }
  if (cfg.scanFullArgs) {
    try {
      const json = JSON.stringify(args);
      parts.push(json.length > 4000 ? json.slice(0, 4000) : json);
    } catch {
      /* ignore */
    }
  }
  return parts.join('\n');
}

function actionForRisk(risk: RiskLevel, cfg: ToolScanCfg): ScanAction {
  if (risk === 'critical') return cfg.onCritical === 'ask' ? 'ask' : 'deny';
  if (risk === 'high') return cfg.onHigh;
  if (risk === 'medium') return cfg.onMedium;
  return 'allow';
}

async function resolveAskOrDeny(
  action: 'ask' | 'deny',
  toolName: string,
  args: unknown,
  summary: string,
  findings: FindingLike[],
): Promise<SecurityResult> {
  if (action === 'ask' && getSecurityCfg().masterBypassAsk && isMasterRequester()) {
    RuntimeUtil.makeLog('warn', `[tool-security] 主人放行: ${toolName}: ${summary}`, 'ToolSecurity');
    return { ok: true, warnings: [summary] };
  }
  if (action === 'ask' && getSecurityCfg().interactiveApproval) {
    const decision = await requestToolApproval({
      toolName,
      args: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
      reason: summary,
      findings,
    });
    if (decision === 'allow') {
      RuntimeUtil.makeLog('info', `[tool-security] 主人批准: ${toolName}`, 'ToolSecurity');
      return { ok: true, warnings: [summary] };
    }
    return { ok: false, error: `安全扫描未获批准: ${summary}`, findings: findings as ThreatPattern[] };
  }
  const verb = action === 'ask' ? '需审批（交互审批未开，已拒绝）' : '已拒绝';
  RuntimeUtil.makeLog('warn', `[tool-security] ${verb} ${toolName}: ${summary}`, 'ToolSecurity');
  return { ok: false, error: `安全扫描${verb}: ${summary}`, findings: findings as ThreatPattern[] };
}

export async function inspectToolCallSecurity(
  toolName: string,
  args: unknown = {},
): Promise<SecurityResult> {
  const policy = checkToolCallAllowed(toolName) as { ok: boolean; error?: string };
  if (!policy.ok) {
    if (policy.error?.includes('ask')) {
      return resolveAskOrDeny('ask', toolName, args, policy.error, []);
    }
    return { ok: false, error: policy.error };
  }

  const cfg = getSecurityCfg();
  if (!cfg.enabled) return { ok: true };

  const text = collectScanText(args);
  const findings = scanTextForThreats(text);
  if (!findings.length) return { ok: true };

  let worst: RiskLevel = 'low';
  for (const f of findings) worst = maxRisk(worst, f.risk);
  const action = actionForRisk(worst, cfg);
  const summary = findings
    .slice(0, 5)
    .map((f) => `${f.risk}:${f.name}（${f.description}）`)
    .join('; ');

  if (action === 'allow') return { ok: true, warnings: [summary] };
  return resolveAskOrDeny(action, toolName, args, summary, findings);
}
