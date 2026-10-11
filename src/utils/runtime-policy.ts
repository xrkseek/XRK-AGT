/**
 * 运行时策略（对齐 opencode Policy + goose tool permission 最小集）。
 * statements: { effect: 'allow'|'deny'|'ask', action, resource }
 * 匹配：action/resource 支持 * 与 ?；同序扫描，**最后一条匹配生效**。
 *
 * 常用 action：
 *   provider.use  — LLM 厂商 key（deny/ask 在选模时拒绝）
 *   tool.call     — MCP 工具名；ask 仍注入工具列表，执行时走审批/拒绝
 *   mcp.connect   — 远程 MCP 服务器名（连接/注册前，ask 按拒绝）
 *
 * 配置：`ai-workflow.policies[]`；空数组 = 全部允许。
 */
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';

export type PolicyEffect = 'allow' | 'deny' | 'ask';
export type PolicyStatement = {
  effect?: string;
  action?: string;
  resource?: string;
};

export function wildcardMatch(pattern: unknown, value: unknown): boolean {
  const p = String(pattern ?? '');
  const v = String(value ?? '');
  if (p === '*' || p === '**') return true;
  if (!p.includes('*') && !p.includes('?')) return p === v;
  let re: RegExp;
  try {
    const esc = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    re = new RegExp(`^${esc}$`, 'i');
  } catch {
    return p === v;
  }
  return re.test(v);
}

export function evaluatePolicy(
  action: string,
  resource: string,
  statements: PolicyStatement[] | null | undefined,
  fallback: 'allow' | 'deny' = 'allow',
): PolicyEffect {
  let decision: PolicyEffect = fallback;
  if (!Array.isArray(statements) || !statements.length) return decision;
  for (const st of statements) {
    if (!st || typeof st !== 'object') continue;
    const eff = String(st.effect || '').toLowerCase();
    if (eff !== 'allow' && eff !== 'deny' && eff !== 'ask') continue;
    if (!wildcardMatch(st.action, action)) continue;
    if (!wildcardMatch(st.resource, resource)) continue;
    decision = eff;
  }
  return decision;
}

export function getRuntimePolicyStatements(): PolicyStatement[] {
  const cfg = getAiWorkflowConfigOptional() || {};
  const raw = cfg.policies ?? cfg.experimental?.policies ?? [];
  return Array.isArray(raw) ? raw : [];
}

export function evaluateRuntimePolicy(
  action: string,
  resource: string,
  fallback: 'allow' | 'deny' = 'allow',
): PolicyEffect {
  return evaluatePolicy(action, resource, getRuntimePolicyStatements(), fallback);
}

/**
 * @throws {Error} deny/ask
 */
export function assertProviderAllowed(providerKey: unknown): void {
  const key = String(providerKey || '').trim();
  if (!key) return;
  const decision = evaluateRuntimePolicy('provider.use', key, 'allow');
  if (decision === 'allow') return;
  const why =
    decision === 'ask'
      ? `策略要求审批（ask），无人值守通道按拒绝处理: provider.use / ${key}`
      : `策略拒绝使用提供商: provider.use / ${key}`;
  throw new Error(why);
}

export function evaluateToolCallPolicy(toolName: unknown): PolicyEffect {
  return evaluateRuntimePolicy('tool.call', String(toolName || ''), 'allow');
}

export function filterToolsByPolicy<T extends { name?: string; function?: { name?: string } }>(
  tools: T[] | null | undefined,
): T[] {
  if (!Array.isArray(tools) || !tools.length) return tools || [];
  if (!getRuntimePolicyStatements().length) return tools;
  return tools.filter((t) => {
    const name = t?.function?.name || t?.name || '';
    // ask 保留在工具列表，执行时由 inspectToolCallSecurity / approval 处理
    return evaluateToolCallPolicy(name) !== 'deny';
  });
}

export function checkToolCallAllowed(
  toolName: string,
): { ok: true } | { ok: false; error: string } {
  const decision = evaluateToolCallPolicy(toolName);
  if (decision === 'allow') return { ok: true };
  const error =
    decision === 'ask'
      ? `工具 "${toolName}" 策略为 ask`
      : `工具 "${toolName}" 被策略拒绝（tool.call）`;
  return { ok: false, error };
}

/**
 * 远程 MCP 连接前策略（mcp.connect）。ask 在无人值守通道按拒绝。
 */
export function checkMcpConnectAllowed(
  serverName: unknown,
): { ok: true } | { ok: false; error: string } {
  const name = String(serverName || '').trim();
  if (!name) return { ok: true };
  const decision = evaluateRuntimePolicy('mcp.connect', name, 'allow');
  if (decision === 'allow') return { ok: true };
  const error =
    decision === 'ask'
      ? `策略要求审批（ask），无人值守通道按拒绝: mcp.connect / ${name}`
      : `策略拒绝连接远程 MCP: mcp.connect / ${name}`;
  return { ok: false, error };
}
