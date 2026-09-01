/**
 * AI 助手运行时 — 走 AGT workflow.process（严格 mergeWorkflows）
 */
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import { flattenMessageSegs, segQq, segReplyId, segText } from '#utils/onebot-message-seg.js';
import { normalizeStringArray } from '#utils/string-array-utils.js';
import ChatStream from '../workflow/chat.js';

export const AI_FULL_PROMPT_DUMP_REGEX = /#?XRK完整AI上下文/;

const cooldownState = new Map();

function resolveAiConfigInstance() {
  try {
    const cm = typeof CommonConfigRegistry !== 'undefined' ? CommonConfigRegistry : null;
    if (!cm?.get) return null;
    const direct = cm.get('ai_config') || cm.get('system-Core/ai_config');
    if (direct) return direct;
    if (typeof cm.getAll === 'function') {
      for (const [key, inst] of cm.getAll()) {
        if (key === 'ai_config' || String(key).endsWith('/ai_config')) return inst;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function findGroupOverride(config, groupId) {
  const gid = String(groupId ?? '');
  if (!gid || !Array.isArray(config?.groupOverrides)) return null;
  return config.groupOverrides.find((row) => String(row?.groupId ?? '') === gid) || null;
}

/**
 * 全局默认 + 群覆盖。
 * 有群覆盖行时 mergeWorkflows 整表替换；llmProvider/prefixes/chance/cooldown/enabled 有值才盖。
 */
export function resolveEffectiveAiConfig(e, config) {
  const base = config && typeof config === 'object' ? config : {};
  const effective = {
    ...base,
    prefixes: normalizeStringArray(base.prefixes),
    mergeWorkflows: normalizeStringArray(base.mergeWorkflows),
    llmProvider: base.llmProvider != null ? String(base.llmProvider).trim() : '',
    cooldown: base.cooldown ?? 300,
    chance: base.chance ?? 0.1,
    enabled: base.enabled !== false,
  };

  if (!e?.isGroup) return effective;
  const ov = findGroupOverride(base, e.group_id);
  if (!ov) return effective;

  if (typeof ov.enabled === 'boolean') effective.enabled = ov.enabled;
  if (Array.isArray(ov.prefixes) && ov.prefixes.length) {
    effective.prefixes = normalizeStringArray(ov.prefixes);
  }
  if (typeof ov.chance === 'number' && Number.isFinite(ov.chance)) {
    effective.chance = ov.chance;
  }
  if (typeof ov.cooldown === 'number' && Number.isFinite(ov.cooldown)) {
    effective.cooldown = ov.cooldown;
  }
  const ovProvider = ov.llmProvider != null ? String(ov.llmProvider).trim() : '';
  if (ovProvider) effective.llmProvider = ovProvider;
  effective.mergeWorkflows = normalizeStringArray(ov.mergeWorkflows);
  return effective;
}

export function messageMatchesAiPrefix(msg, prefixes) {
  const text = String(msg ?? '');
  if (!text) return false;
  for (const p of normalizeStringArray(prefixes)) {
    if (p && text.startsWith(p)) return true;
  }
  return false;
}

export async function loadAiAssistantConfig() {
  const inst = resolveAiConfigInstance();
  if (inst && typeof inst.read === 'function') return inst.read(true);
  if (inst && typeof inst === 'object' && !inst.read) return inst;
  const { default: AIConfig } = await import('../commonconfig/ai_config.js');
  return new AIConfig().read(true);
}

export function stripAiFullPromptDumpMark(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  return raw
    .replace(AI_FULL_PROMPT_DUMP_REGEX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function rawMessageTextForAiTrigger(e) {
  if (e?.msg != null && String(e.msg).trim() !== '') return String(e.msg);
  if (!Array.isArray(e?.message)) return '';
  return flattenMessageSegs(e.message).map((seg) => (seg?.type === 'text' ? segText(seg) : '')).join('');
}

export function resolveChatStream(plugin) {
  return plugin.getWorkflow?.('chat') || AiWorkflowLoader.getWorkflow?.('chat') || null;
}

export function isInAiWhitelist(e, config) {
  if (!config) return false;
  if (e.isGroup) {
    const groups = config.groups;
    if (!Array.isArray(groups) || groups.length === 0) return true;
    return groups.some((g) => String(g) === String(e.group_id));
  }
  const users = config.users;
  if (!Array.isArray(users) || users.length === 0) return false;
  return users.some((u) => String(u) === String(e.user_id));
}

export async function shouldTriggerAI(e, config) {
  if (!config) return false;
  const effective = resolveEffectiveAiConfig(e, config);
  if (effective.enabled === false) return false;

  if (e.atBot) return isInAiWhitelist(e, config);
  if (messageMatchesAiPrefix(e.msg, effective.prefixes)) {
    return isInAiWhitelist(e, config);
  }
  if (!e.isGroup || !isInAiWhitelist(e, config)) return false;

  const groupId = String(e.group_id);
  const now = Date.now();
  const last = cooldownState.get(groupId) || 0;
  if (now - last < (effective.cooldown ?? 300) * 1000) return false;
  if (Math.random() < (effective.chance ?? 0.1)) {
    cooldownState.set(groupId, now);
    return true;
  }
  return false;
}

function replyTargetIdFromEvent(e) {
  const seg = Array.isArray(e?.message)
    ? e.message.find((s) => s && s.type === 'reply')
    : null;
  const fromSeg = segReplyId(seg);
  if (fromSeg) return fromSeg;
  const fromSource = e?.source?.message_id ?? e?.source?.id;
  return fromSource != null && String(fromSource).trim() !== '' ? String(fromSource).trim() : null;
}

function summarizeReplyRaw(reply) {
  if (!reply) return '';
  if (reply.raw_message) return String(reply.raw_message).replace(/\s+/g, ' ').trim();
  if (!Array.isArray(reply.message)) return '';
  return flattenMessageSegs(reply.message)
    .map((seg) => {
      if (!seg || typeof seg !== 'object') return '';
      if (seg.type === 'text') return segText(seg);
      if (seg.type === 'image' || seg.type === 'mface') return '[图片]';
      if (seg.type === 'file') return `[文件:${seg.name || '未知'}]`;
      if (seg.type === 'at') return `@${segQq(seg)}`;
      return '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function processMessageContent(e) {
  const fallback = e.msg || '';
  const message = e.message;
  if (!Array.isArray(message)) return stripAiFullPromptDumpMark(String(fallback));

  try {
    let content = '';
    const replyId = replyTargetIdFromEvent(e);
    if (replyId) content += `[回复:${replyId}] `;
    if (replyId && typeof e.getReply === 'function') {
      try {
        const reply = await e.getReply();
        const raw = summarizeReplyRaw(reply).slice(0, 180);
        if (raw) {
          const name = reply?.sender?.card || reply?.sender?.nickname || '未知';
          content += `${name}「${raw}」 `;
        }
      } catch { /* ignore */ }
    }

    for (const seg of flattenMessageSegs(message)) {
      if (!seg || seg.type === 'reply') continue;
      if (seg.type === 'text') content += segText(seg);
      else if (seg.type === 'at') {
        const qqStr = segQq(seg);
        if (!qqStr) continue;
        content += qqStr === String(e.self_id) || qqStr === 'all'
          ? `@机器人(${e.self_id}) `
          : `@${qqStr} `;
      } else if (seg.type === 'image' || seg.type === 'mface') content += '[图片] ';
      else if (seg.type === 'file') content += `[文件:${seg.name || '未知'}] `;
      else if (seg.type === 'face') content += '[表情] ';
    }
    return stripAiFullPromptDumpMark(content.trim());
  } catch (err) {
    logger.error(`[XRK-AI] processMessageContent: ${err.message}`);
    return stripAiFullPromptDumpMark(String(fallback));
  }
}

export async function runChatAgent(plugin, e, {
  text,
  persona = '',
  config,
  isGlobalTrigger = false,
  debugDumpFullPrompt = false,
} = {}) {
  const stream = resolveChatStream(plugin);
  if (!stream) {
    logger.error('[XRK-AI] chat 工作流未加载');
    return false;
  }

  const effective = resolveEffectiveAiConfig(e, config);
  const options = {
    mergeWorkflows: normalizeStringArray(effective.mergeWorkflows),
  };
  if (effective.llmProvider) {
    options.provider = effective.llmProvider;
  }
  // Agent loop：@xrkseek/harness（callAI / /v1+MCP）；见 docs/harness-module-loop.md
  await stream.process(
    e,
    { content: text, text, persona, isGlobalTrigger, debugDumpFullPrompt: !!debugDumpFullPrompt },
    options,
  );
  return true;
}

export async function handleClearConversation(e) {
  const historyKey = ChatStream.getEventHistoryKey(e) ?? String(e.group_id || e.user_id);
  const result = await ChatStream.clearConversation(historyKey, { e });
  if (result.success) {
    const items = [];
    if (result.cleared.history) items.push('聊天记录');
    await e.reply(`✅ 对话已重置！已清除：${items.join('、') || '无'}`);
  } else {
    await e.reply('❌ 清除对话失败，请稍后重试');
  }
  return true;
}

export function logAiInit(config) {
  const prefixes = normalizeStringArray(config?.prefixes);
  const overrides = Array.isArray(config?.groupOverrides) ? config.groupOverrides.length : 0;
  const provider = config?.llmProvider != null ? String(config.llmProvider).trim() : '';
  logger.mark(
    `[XRK-AI] 就绪 · 群 ${config.groups?.length || 0} · 用户 ${config.users?.length || 0}`
    + ` · 前缀[${prefixes.join(',') || '无'}] · 群覆盖 ${overrides}`
    + ` · llm=${provider || 'ai-workflow'} · merge=[${normalizeStringArray(config?.mergeWorkflows).join(',')}]`
    + ` · loop=@xrkseek/harness`,
  );
}
