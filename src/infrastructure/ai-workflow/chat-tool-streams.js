/**
 * chat 工具流白名单解析。
 *
 * 优先级：
 * 1. 请求 ALS 的 toolStreamNames（process 写入，并发隔离）
 * 2. 合成流 _mergedStreams
 * 3. 裸 chat 开放模式 → 仅扩展 frameworkToolSurface（remote-mcp.* 须显式列入名单）
 */
import RuntimeUtil from '#utils/runtime-util.js';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import { getWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js';
import { normalizeStringArray } from '#utils/string-array-utils.js';

export const CHAT_FRAMEWORK_TOOL_WORKFLOWS = ['web', 'browser'];

export function isChatToolSurface(stream) {
  if (!stream) return false;
  if (stream.name === 'chat' || stream.primaryStream === 'chat') return true;
  if (Array.isArray(stream._mergedStreams) && stream._mergedStreams.some((s) => s?.name === 'chat')) {
    return true;
  }
  return typeof stream.name === 'string'
    && (stream.name === 'chat-merged' || stream.name.startsWith('chat-'));
}

export function isRemoteMcpStreamName(name) {
  return String(name ?? '').startsWith('remote-mcp.');
}

/** 可 merge 的实体流 vs 仅工具面名字（remote-mcp.*） */
export function partitionToolStreamNames(names) {
  const mergeable = [];
  const toolOnly = [];
  for (const n of normalizeStringArray(names)) {
    if (isRemoteMcpStreamName(n)) toolOnly.push(n);
    else mergeable.push(n);
  }
  return { mergeable, toolOnly };
}

export function getFrameworkToolWorkflowNames() {
  const fromMeta = [];
  try {
    for (const s of AiWorkflowLoader.workflows.values()) {
      if (!s?.frameworkToolSurface || !s.name) continue;
      if (Array.isArray(s._mergedStreams) && s._mergedStreams.length > 0) continue;
      if (!fromMeta.includes(s.name)) fromMeta.push(s.name);
    }
  } catch (err) {
    RuntimeUtil.makeLog('debug', `扫描 frameworkToolSurface 失败: ${err?.message || err}`, 'ChatToolStreams');
  }
  return fromMeta.length ? fromMeta : [...CHAT_FRAMEWORK_TOOL_WORKFLOWS];
}

/** 开放模式：补 frameworkToolSurface；remote-mcp.* 不自动并入（须与 workflow 一样显式传入） */
export function expandChatToolWorkflowWhitelist(baseNames) {
  const names = normalizeStringArray(baseNames);
  for (const n of getFrameworkToolWorkflowNames()) {
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

function streamOwnNames(stream) {
  if (Array.isArray(stream?._mergedStreams) && stream._mergedStreams.length > 0) {
    return stream._mergedStreams.map((s) => s.name).filter(Boolean);
  }
  return [stream?.name].filter(Boolean);
}

/** 供 AiWorkflow / 副提示解析工具流名单（先读 ALS，避免单例缓存串请求） */
export function resolveToolStreamNames(stream) {
  const ctx = getWorkflowRequestContext();
  if (Array.isArray(ctx?.toolStreamNames)) {
    return normalizeStringArray(ctx.toolStreamNames);
  }

  const own = streamOwnNames(stream);
  if (!isChatToolSurface(stream)) return own;
  if (Array.isArray(stream._mergedStreams) && stream._mergedStreams.length > 0) return own;
  return expandChatToolWorkflowWhitelist(own);
}

/**
 * 收集已并入 chat 工具面的副流 `buildSystemPrompt`，拼成 system「可用能力」段。
 * 例如 merge 含 `tools` 时注入 `### tools` + 文件工具使用约定（含 apply_edit / repo_map 等）。
 */
export function collectAuxiliaryStreamPrompts(stream, context = {}) {
  if (!stream || !isChatToolSurface(stream)) return '';
  const names = resolveToolStreamNames(stream);
  const skip = new Set(['chat', stream.name].filter(Boolean));
  const parts = [];

  for (const name of names) {
    if (skip.has(name) || isRemoteMcpStreamName(name) || name.startsWith('chat-')) continue;
    const aux = AiWorkflowLoader.getWorkflow(name);
    if (!aux || typeof aux.buildSystemPrompt !== 'function') continue;
    try {
      const out = aux.buildSystemPrompt(context);
      const text = typeof out === 'string' ? out : (out != null ? String(out) : '');
      if (text.trim()) parts.push(`### ${name}\n${text.trim()}`);
    } catch {
      /* ignore */
    }
  }

  if (!parts.length) return '';
  return `\n\n## 可用能力\n\n${parts.join('\n\n')}`;
}
