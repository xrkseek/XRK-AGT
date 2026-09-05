/**
 * XRK AI 助手 — 对齐 XRK-Yunzai plugin/ai.js
 *
 * 职责：触发（@ / 前缀 / 随机）→ `runChatAgent` → `ChatStream.process({ mergeWorkflows })`。
 * 不在此注册 MCP；文件工具面随 `ai_config.mergeWorkflows`（默认含 `tools`）并入 chat。
 * 斜杠 `/recipe`、压缩、策略/安全扫描在 chat-pipeline / MCP 执行链，本插件只做入口。
 */
import RuntimeUtil from '#utils/runtime-util.js';
import {
  AI_FULL_PROMPT_DUMP_REGEX,
  handleClearConversation,
  loadAiAssistantConfig,
  logAiInit,
  messageMatchesAiPrefix,
  processMessageContent,
  rawMessageTextForAiTrigger,
  resolveChatStream,
  resolveEffectiveAiConfig,
  runChatAgent,
  shouldTriggerAI,
  isInAiWhitelist,
} from '../lib/ai-assistant-runtime.js';
import PluginBase from '#infrastructure/plugins/plugin-base.js';
import { msgSegment } from '#utils/msg-segment.js';

const gLogger = (): any => (globalThis as any).logger;

export class XRKAIAssistant extends PluginBase {
  [key: string]: any;
  constructor() {
    super({
      name: 'XRK-AI助手',
      dsc: '智能 AI 助手：@、前缀、随机触发，合并 Agent 工作流',
      event: 'message',
      priority: 99999,
      rule: [{ reg: '.*', fnc: 'handleMessage', log: false }],
    });
  }

  async init() {
    this.config = await loadAiAssistantConfig();
    logAiInit(this.config);
  }

  async handleMessage() {
    const e = this.e;
    try {
      // 每次触发重读，与 CommonConfig 热更对齐（ConfigBase 有缓存）
      this.config = await loadAiAssistantConfig();

      const msgText = String(e.msg || '').trim();
      const normalized = msgText.startsWith('#') ? msgText.slice(1).trim() : msgText;
      if (normalized === '清空对话') {
        if (!e.isMaster) {
          await e.reply('仅主人可以清空对话哦～');
          return true;
        }
        return handleClearConversation(e);
      }

      // 总开关：全局关闭则整插件不响应（群覆盖不能打开）
      if (this.config.enabled === false) return false;

      const effective = resolveEffectiveAiConfig(e, this.config);
      if (effective.enabled === false) return false;

      const rawForDump = rawMessageTextForAiTrigger(e);
      const debugDumpFullPrompt = AI_FULL_PROMPT_DUMP_REGEX.test(rawForDump);
      if (debugDumpFullPrompt && !isInAiWhitelist(e, this.config)) {
        return false;
      }

      if (!debugDumpFullPrompt && !(await shouldTriggerAI(e, this.config))) {
        return false;
      }

      const stream = resolveChatStream(this);
      if (!stream) {
        gLogger()?.error('[XRK-AI] chat 工作流未加载');
        return false;
      }

      const isRandom = !e.atBot && !messageMatchesAiPrefix(e.msg, effective.prefixes);
      const text = await processMessageContent(e);
      const isGlobalTrigger = isRandom && !debugDumpFullPrompt;

      if (!debugDumpFullPrompt && !isGlobalTrigger && !text) {
        const img = stream.getRandomEmotionImage?.('惊讶');
        if (img) await e.reply(msgSegment.image(img));
        await RuntimeUtil.sleep(300);
        await e.reply('有什么需要帮助的吗？');
        return true;
      }

      await runChatAgent(this, e, {
        text,
        persona: effective.persona ?? '',
        config: this.config,
        isGlobalTrigger,
        debugDumpFullPrompt,
      } as any);
      return true;
    } catch (err: any) {
      gLogger()?.error(`[XRK-AI] handleMessage: ${err.message}`);
      return false;
    }
  }
}
