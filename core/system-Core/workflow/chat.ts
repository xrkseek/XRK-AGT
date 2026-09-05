// @ts-nocheck
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { errorHandler, ErrorCodes } from '#utils/error-handler.js';
import {
  EMOTION_TYPES,
  EMOTION_IMAGE_EXTS,
  EMOJI_REACTION_ALIASES,
  EMOJI_REACTION_TYPES,
  formatEmotionTypeList,
  getEmojiReactionIds,
  normalizeEmotionType
} from '#utils/emotion-categories.js';
import {
  actionAck,
  createUserVisibleTurnState,
  formatReplySentAck,
  formatSessionWhere,
  formatUserVisibleDuplicateAck,
  isOverlappingUserVisible
} from '#utils/chat-user-visible-ack.js';
import {
  getWorkflowRequestContext,
  runWithWorkflowRequestContext
} from '#infrastructure/ai-workflow/workflow-request-context.js';
import { assembleChatLlmMessages, logLlmMessagePreview } from '#infrastructure/ai-workflow/chat-pipeline.js';
import { BaseTools } from '#utils/base-tools.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { resolveConfiguredWorkspace } from '../lib/ai-workspace-runtime.js';
import {
  buildOutboundSegments,
  collectReplyAtQqs,
  contentHasGroupAt,
  prependReplyAtMarkers,
  replyContentForbidden,
  resolveOutgoingMessage,
  splitProtocolParts,
} from '#utils/chat-reply-protocol.js';
import {
  flattenMessageSegs,
  segFileName,
  segQq,
  segReplyId,
  segText,
} from '#utils/onebot-message-seg.js';
import { chatSessionHistory } from '#utils/chat-session-history.js';
import { resolveTaskerId } from '#utils/event-keys.js';
import { summarizeToolForHistory } from '#utils/mcp-tool-result-text.js';
import { readMediaBuffer } from '#utils/entry-media.js';
import {
  buildAgtUserContent,
  extractVisionFromEvent,
  extractVisionFromSegments,
  visionRefToLocator
} from '#utils/llm/vision-content.js';

function historyPlatform(e) {
  return resolveTaskerId(e) || (e?.isDevice ? 'device' : e?.isStdin ? 'stdin' : 'onebot');
}
const EMOTIONS_DIR = path.join(process.cwd(), 'resources/aiimages');
const IMAGE_SEND_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function randomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 剥离历史遗留的「使用了/执行了」调试前缀，避免再喂给模型 */
function stripLegacyToolUsagePrefix(text) {
  return String(text ?? '')
    .replace(/^［使用了:[^］]*］\s*/u, '')
    .replace(/^\[执行了:[^\]]*\]\s*/u, '')
    .trim();
}

/** 聊天工作流：群聊/互动/群管 MCP 工具 */
export default class ChatStream extends AiWorkflow {
  static emotionImages = {};
  /** 笔录单例（勿再 new Map：FileLoader ?t= 热重载会拆出多份静态字段） */
  static get messageHistory() {
    return chatSessionHistory;
  }
  static cleanupTimer = null;
  /**
   * 已通过用户可见动作体现的工具，不再重复记【我·工具】（基名匹配）。
   */
  static TOOL_HISTORY_SKIP = new Set([
    'reply', 'emotion', 'send_file', 'send_image', 'poke',
    'relayPrivate', 'relayPrivateImage', 'relayPrivateEmotion', 'relayPrivateFile',
    'thumbUp', 'emojiReaction', 'recall'
  ]);

  constructor() {
    super({
      name: 'chat',
      description: '智能聊天互动工作流',
      version: '3.2.0',
      author: 'XRK',
      priority: 10,
      config: {
        enabled: true,
        temperature: 0.8,
        maxTokens: 6000,
        topP: 0.9,
        presencePenalty: 0.6,
        frequencyPenalty: 0.6,
        /** 多工具同轮时顺序执行，避免 reply 与其它 MCP 抢跑 */
        parallel_tool_calls: false
      },
      embedding: { enabled: true }
    });
  }

  /**
   * 初始化工作流
   */
  async init() {
    await super.init();
    
    try {
      await RuntimeUtil.mkdir(EMOTIONS_DIR);
      await this.loadEmotionImages();
      this.registerAllFunctions();
      
      if (!ChatStream.cleanupTimer) {
        ChatStream.cleanupTimer = setInterval(() => this.cleanupCache(), 300000);
      }
    } catch (error) {
      const botError = errorHandler.handle(
        error,
        { context: 'ChatStream.init', code: ErrorCodes.SYSTEM_ERROR },
        true
      );
      RuntimeUtil.makeLog('error', 
        `[${this.name}] 初始化失败: ${botError.message}`, 
        'ChatStream'
      );
      throw botError;
    }
  }

  /**
   * 加载表情包
   */
  async loadEmotionImages() {
    for (const emotion of EMOTION_TYPES) {
      const emotionDir = path.join(EMOTIONS_DIR, emotion);
      try {
        await RuntimeUtil.mkdir(emotionDir);
        const files = await fs.promises.readdir(emotionDir);
        const imageFiles = files.filter((file) => EMOTION_IMAGE_EXTS.test(file));
        ChatStream.emotionImages[emotion] = imageFiles.map((file) =>
          path.join(emotionDir, file)
        );
      } catch {
        ChatStream.emotionImages[emotion] = [];
      }
    }
  }

  /**
   * 检查是否为群聊环境
   * @param {Object} context - 上下文对象
   * @returns {Object|null} 如果不是群聊返回错误对象，否则返回null
   */
  _requireGroup(context) {
    if (!context.e?.isGroup) {
      return { success: false, error: '非群聊环境' };
    }
    return null;
  }

  /** 群管写操作：机器人须为群主/管理员 */
  async _requireGroupAdmin(context) {
    const groupCheck = this._requireGroup(context);
    if (groupCheck) return groupCheck;
    const role = await this.getBotRole(context.e);
    if (role !== '群主' && role !== '管理员') {
      return { success: false, error: '需要群主或管理员权限' };
    }
    return null;
  }

  /** 查询类工具返回：附 data，提示勿重复调用 */
  _queryToolRawDetail(description, data, e) {
    const MAX = 4000;
    let dataStr = '{}';
    try {
      dataStr = data != null ? (typeof data === 'string' ? data : JSON.stringify(data)) : '{}';
    } catch {
      dataStr = String(data);
    }
    if (dataStr.length > MAX) dataStr = `${dataStr.slice(0, MAX)}\n...[已截断]`;
    const head = e?.isGroup && e?.group_id
      ? `你已在群 ${e.group_id} 获取${description}。根据 data 回复，勿再调用。`
      : e?.user_id
        ? `你已获取与 ${e.user_id} 相关的${description}。根据 data 回复，勿再调用。`
        : `你已获取${description}。根据 data 回复，勿再调用。`;
    return `${head}\n\ndata:\n${dataStr}`;
  }

  _normalizeTargetQq(qq) {
    const s = String(qq ?? '').trim();
    if (!/^\d{5,10}$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return String(n);
  }

  async _pickFriendSender(e, qq) {
    const targetQq = this._normalizeTargetQq(qq);
    if (!targetQq) return { error: 'qq 须为 5-10 位数字' };
    const bot = e?.bot;
    if (!bot?.pickFriend) return { error: '当前环境不支持私聊传话' };
    if (typeof bot.getFriendMap === 'function') {
      try { await bot.getFriendMap(); } catch { /* ignore */ }
    }
    const inList =
      bot.fl?.has?.(targetQq) ||
      bot.fl?.has?.(parseInt(targetQq, 10)) ||
      bot.fl?.get?.(targetQq) != null ||
      bot.fl?.get?.(parseInt(targetQq, 10)) != null;
    if (!inList) {
      return { error: `QQ ${targetQq} 不在机器人好友列表，无法私聊传话` };
    }
    const friend = bot.pickFriend(targetQq);
    if (!friend?.sendMsg) return { error: '无法获取好友私聊发送能力' };
    const info = bot.fl?.get?.(targetQq) || bot.fl?.get?.(parseInt(targetQq, 10)) || {};
    return { friend, targetQq, displayName: info.remark || info.nickname || targetQq };
  }

  _relayPrivateFail(targetQq, message) {
    const detail = String(message?.message || message || '私聊发送失败').trim();
    const normalized = detail.startsWith('QQ ') ? detail : `私聊未发出：${detail}`;
    return {
      success: false,
      error: normalized,
      raw: `${normalized}。禁止 reply 声称已发送；请向当前会话如实说明。`
    };
  }

  async _wrapRelayPrivateHandler(targetQq, fn, delay = 300) {
    try {
      const result = await fn();
      if (result?.success === false) {
        return this._relayPrivateFail(targetQq, result.error || result.raw || '私聊发送失败');
      }
      if (delay > 0) await RuntimeUtil.sleep(delay);
      return result;
    } catch (err) {
      return this._relayPrivateFail(targetQq, err);
    }
  }

  _relayFromWhere(e) {
    return e?.isGroup && e?.group_id ? `群 ${e.group_id}` : '当前会话';
  }

  _relayPrivateAck(e, picked, detail) {
    return actionAck(`你已从${this._relayFromWhere(e)}向好友 ${picked.displayName}(${picked.targetQq}) ${detail}`);
  }

  /** 向好友发协议正文（| 分句 / at 标记不适用好友） */
  async _relayPrivateOutbound(friend, { content, imagePaths = [] } = {}) {
    const text = String(content ?? '').trim();
    const parts = text ? splitProtocolParts(text) : [''];
    let totalSent = 0;
    const allSentContent = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const { displayText, segments } = resolveOutgoingMessage(part, { fallbackReplyId: null });
      const segs = [...(segments || [])];
      if (i === 0 && imagePaths.length) {
        for (const p of imagePaths) segs.unshift(msgSegment.image(p));
      }
      const payload = buildOutboundSegments({ replyId: null, segments: segs });
      if (!payload.length && !imagePaths.length) continue;
      await friend.sendMsg(payload.length ? payload : [msgSegment.image(imagePaths[0])]);
      totalSent++;
      if (displayText) allSentContent.push(displayText);
    }
    return { totalSent, allSentContent };
  }

  async _relayPrivateImageSend(friend, absPath, text = '') {
    const caption = String(text ?? '').trim();
    if (!caption) {
      await friend.sendMsg([msgSegment.image(absPath)]);
      return { totalSent: 1, allSentContent: [] };
    }
    const forbidden = replyContentForbidden(caption);
    if (forbidden) return { error: forbidden };
    return this._relayPrivateOutbound(friend, { content: caption, imagePaths: [absPath] });
  }

  async _relayPrivateFileSend(friend, absPath, displayName, text = '') {
    const caption = String(text ?? '').trim();
    if (caption) {
      const forbidden = replyContentForbidden(caption);
      if (forbidden) return { error: forbidden };
      const { totalSent } = await this._relayPrivateOutbound(friend, { content: caption });
      if (totalSent < 1) return { error: '未能发出私聊附言' };
    }
    if (!friend?.sendFile) return { error: '无法私聊发送文件' };
    await friend.sendFile(absPath, displayName);
    return { success: true };
  }

  /** 好友管理写操作：仅主人 */
  _requireMaster(context) {
    if (context.e?.isMaster !== true) {
      return { success: false, error: '需要主人权限' };
    }
    return null;
  }

  _getTurnState(context) {
    const turn = context?.turnState ?? getWorkflowRequestContext()?.turnState;
    if (turn) return turn;
    RuntimeUtil.makeLog('warn', '[ChatStream] 无请求级 turnState，reply 队列可能串线', 'ChatStream');
    return createUserVisibleTurnState();
  }

  /**
   * 统一错误处理包装器
   * @param {Function} fn - 要执行的异步函数
   * @param {number} [delay=300] - 执行后的延迟（毫秒）
   * @returns {Promise<Object>} 返回结果对象
   */
  async _wrapHandler(fn, delay = 300) {
    try {
      const result = await fn();
      if (delay > 0) await RuntimeUtil.sleep(delay);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  _chatWorkspaceAbs() {
    const fileCfg = getAiWorkflowConfigOptional().tools?.file ?? {};
    return resolveConfiguredWorkspace(fileCfg.workspace);
  }

  /** 解析工作区内文件路径（send_file / send_image） */
  _resolveWorkspaceFile(_context, filePath, { requireImage = false, rejectImage = false } = {}) {
    const rel = String(filePath ?? '').trim();
    if (!rel) return { error: 'filePath 不能为空' };
    const baseTools = new BaseTools(this._chatWorkspaceAbs());
    let absPath;
    try {
      absPath = baseTools.resolvePath(rel);
    } catch (err) {
      return { error: err.message || '路径无效' };
    }
    if (!fs.existsSync(absPath)) return { error: `文件不存在: ${rel}` };
    const ext = path.extname(absPath).toLowerCase();
    if (requireImage && !IMAGE_SEND_EXTS.has(ext)) {
      return { error: '非图片文件，请用 send_file' };
    }
    if (rejectImage && IMAGE_SEND_EXTS.has(ext)) {
      return { error: '图片请用 send_image' };
    }
    return { absPath, displayName: path.basename(absPath) };
  }

  /** 将相对路径解析到工作区内（禁止逃逸） */
  _resolveWorkspaceWriteAbs(relPath) {
    const rel = String(relPath ?? '').trim().replace(/\\/g, '/');
    if (!rel) throw new Error('相对路径不能为空');
    const root = path.resolve(this._chatWorkspaceAbs());
    const absPath = path.resolve(root, rel);
    const outside = path.relative(root, absPath);
    if (outside.startsWith('..') || path.isAbsolute(outside)) {
      throw new Error('路径超出工作区');
    }
    return absPath;
  }

  async _fetchMessageById(e, msgId) {
    if (!e || !msgId) return null;
    const id = String(msgId).trim();
    if (!id) return null;

    if (e.message_id != null && String(e.message_id) === id && Array.isArray(e.message)) {
      return {
        message_id: e.message_id,
        message: flattenMessageSegs(e.message),
        sender: e.sender,
        time: e.time,
        user_id: e.user_id,
        raw_message: e.raw_message
      };
    }

    const historyKey = ChatStream.getEventHistoryKey(e);
    if (historyKey) {
      const history = ChatStream.messageHistory.get(historyKey) || [];
      const cached = history.find((m) => ChatStream.historyEntryId(m) === id);
      if (cached?._rawMessage && Array.isArray(cached._rawMessage) && cached._rawMessage.length > 0) {
        return {
          message_id: cached.message_id,
          message: flattenMessageSegs(cached._rawMessage),
          sender: { user_id: cached.user_id, nickname: cached.nickname },
          time: cached.time,
          raw_message: cached.message,
          user_id: cached.user_id
        };
      }
    }

    if (e.bot?.sendApi) {
      try {
        const result = await e.bot.sendApi('get_msg', { message_id: id });
        if (result?.data) {
          const data = result.data;
          return {
            ...data,
            message: flattenMessageSegs(data.message)
          };
        }
      } catch (err) {
        RuntimeUtil.makeLog('debug', `[ChatStream] get_msg 失败 msgId=${id}: ${err?.message}`, 'ChatStream');
      }
    }
    if (typeof e.getReply === 'function' && String(ChatStream.getReplySegmentId(e) || '') === id) {
      try {
        const reply = await e.getReply();
        if (reply) {
          return {
            ...reply,
            message: flattenMessageSegs(reply.message)
          };
        }
      } catch {
        /* ignore */
      }
    }

    // 最后回退：仅有历史文本、无段数据（无法再下载媒体，但仍可供引用摘要）
    if (historyKey) {
      const history = ChatStream.messageHistory.get(historyKey) || [];
      const cached = history.find((m) => ChatStream.historyEntryId(m) === id);
      if (cached) {
        return {
          message_id: cached.message_id,
          message: flattenMessageSegs(cached._rawMessage || []),
          sender: { user_id: cached.user_id, nickname: cached.nickname },
          time: cached.time,
          raw_message: cached.message,
          user_id: cached.user_id
        };
      }
    }
    return null;
  }

  _extractMessageAssets(message) {
    const assets = [];
    if (!Array.isArray(message)) return assets;
    for (const seg of message) {
      if (!seg || typeof seg !== 'object') continue;
      const data = seg.data || seg;
      if (seg.type === 'image') {
        assets.push({
          type: 'image',
          url: seg.url || data.url,
          file: data.file || seg.file
        });
      } else if (seg.type === 'video') {
        assets.push({
          type: 'video',
          name: data.name || seg.name,
          url: data.url || seg.url,
          file: data.file || seg.file,
          file_id: data.file_id || seg.file_id
        });
      } else if (seg.type === 'record' || seg.type === 'audio') {
        assets.push({
          type: 'record',
          name: data.name || seg.name,
          url: data.url || seg.url,
          file: data.file || seg.file,
          file_id: data.file_id || seg.file_id
        });
      } else if (seg.type === 'file') {
        assets.push({
          type: 'file',
          name: data.name || seg.name,
          url: data.url || seg.url,
          file: data.file || seg.file,
          file_id: data.file_id || seg.file_id || data.fid
        });
      } else if (seg.type === 'mface') {
        assets.push({
          type: 'mface',
          url: data.url || seg.url,
          file: data.file || seg.file,
          summary: data.summary
        });
      }
    }
    return assets;
  }

  _guessAssetExtension(asset) {
    if (asset?.type === 'file' && asset.name) {
      const ext = path.extname(asset.name);
      if (ext) return ext;
    }
    if (asset?.url || asset?.file) {
      const fromName = path.extname(String(asset.file || asset.url).split('?')[0]);
      if (IMAGE_SEND_EXTS.has(fromName.toLowerCase())) return fromName.toLowerCase();
      if (fromName) return fromName.toLowerCase();
    }
    if (asset?.type === 'image' || asset?.type === 'mface') return '.png';
    if (asset?.type === 'video') return '.mp4';
    if (asset?.type === 'record') return '.amr';
    return '.bin';
  }

  /**
   * 段 → 历史文本 + 媒体标记（图片/文件用标记；reply 保留 [回复:id]）
   * 兼容事件扁平段与 get_msg 的 data 嵌套段。
   */
  _segmentsToHistoryParts(segments) {
    if (!Array.isArray(segments)) {
      return { text: '', hasImage: false, hasFile: false, hasFace: false };
    }
    let hasImage = false;
    let hasFile = false;
    let hasFace = false;
    const text = flattenMessageSegs(segments)
      .map((seg) => {
        if (!seg || typeof seg !== 'object') return '';
        switch (seg.type) {
          case 'text':
            return segText(seg);
          case 'image':
          case 'mface':
            hasImage = true;
            return '[图片]';
          case 'video':
            hasFile = true;
            return '[视频]';
          case 'record':
          case 'audio':
            hasFile = true;
            return '[语音]';
          case 'file':
            hasFile = true;
            return `[文件:${segFileName(seg)}]`;
          case 'face':
            hasFace = true;
            return '[表情]';
          case 'at': {
            const qq = segQq(seg);
            return qq ? `@${qq}` : '';
          }
          case 'reply': {
            const id = segReplyId(seg);
            return id ? `[回复:${id}]` : '';
          }
          default:
            return '';
        }
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return { text, hasImage, hasFile, hasFace };
  }

  async _downloadMessageAssetToWorkspace(e, asset, relPath) {
    const absPath = this._resolveWorkspaceWriteAbs(relPath);
    await fsPromises.mkdir(path.dirname(absPath), { recursive: true });
    const sendApi = e.bot?.sendApi ? (action, params) => e.bot.sendApi(action, params) : undefined;

    if (asset.type === 'face') {
      throw new Error('内置 QQ 表情（face）无法下载；请用 emotion 或让用户发图片/自定义表情包');
    }

    if ((asset.type === 'image' || asset.type === 'mface') && (asset.file || asset.url)) {
      const buf = await readMediaBuffer({ file: asset.file, url: asset.url }, sendApi, { type: 'image' });
      if (buf?.length) {
        await RuntimeUtil.writeFile(absPath, buf);
        return absPath;
      }
    }

    if (['file', 'video', 'record'].includes(asset.type) && (asset.file || asset.url || asset.file_id)) {
      const buf = await readMediaBuffer(
        { file: asset.file, url: asset.url, file_id: asset.file_id, type: asset.type },
        sendApi,
        { type: asset.type },
      );
      if (buf?.length) {
        await RuntimeUtil.writeFile(absPath, buf);
        return absPath;
      }
    }

    const candidates = [asset.file, asset.file_id, asset.id, asset.url, asset.path]
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);

    for (const ref of candidates) {
      const local = ref.replace(/^file:\/\//i, '');
      if (!/^https?:\/\//i.test(local) && (await RuntimeUtil.fileExists(local))) {
        await fsPromises.copyFile(local, absPath);
        return absPath;
      }
    }

    if (sendApi) {
      for (const fileRef of candidates) {
        if (/^https?:\/\//i.test(fileRef)) continue;
        for (const params of [{ file: fileRef }, { file_id: fileRef }]) {
          try {
            const result = await e.bot.sendApi('get_file', params);
            const d = result?.data || {};
            const local = d.file || d.path;
            if (local && (await RuntimeUtil.fileExists(local))) {
              await fsPromises.copyFile(local, absPath);
              return absPath;
            }
            if (d.base64) {
              const raw = String(d.base64).replace(/^base64:\/\//, '');
              if (raw) {
                await RuntimeUtil.writeFile(absPath, Buffer.from(raw, 'base64'));
                return absPath;
              }
            }
            if (d.url && /^https?:\/\//i.test(String(d.url))) {
              const resp = await fetch(String(d.url), { signal: AbortSignal.timeout(60000) });
              if (resp.ok) {
                await RuntimeUtil.writeFile(absPath, Buffer.from(await resp.arrayBuffer()));
                return absPath;
              }
            }
          } catch {
            /* try next */
          }
        }
      }
    }

    for (const ref of candidates) {
      if (!/^https?:\/\//i.test(ref)) continue;
      try {
        const resp = await fetch(ref, { signal: AbortSignal.timeout(60000) });
        if (resp.ok) {
          await RuntimeUtil.writeFile(absPath, Buffer.from(await resp.arrayBuffer()));
          return absPath;
        }
      } catch {
        /* try next */
      }
    }

    throw new Error('无法获取可下载的资源（临时链可能已过期，或缺少本地文件）');
  }

  /** 解析本轮「回复/引用」目标，供 [当前消息] 强调 */
  async _resolveInboundReplyContext(e) {
    const replyId = ChatStream.getReplySegmentId(e);
    if (replyId == null && e?.source?.id == null && e?.source?.message_id == null) return null;

    let replyMsg = null;
    if (typeof e.getReply === 'function') {
      try {
        replyMsg = await e.getReply();
      } catch {
        /* ignore */
      }
    }
    const id = String(
      replyMsg?.message_id || replyMsg?.id || replyId || e.source?.message_id || e.source?.id || ''
    ).trim();
    if (!id) return null;

    if (!replyMsg || (!replyMsg.raw_message && !(replyMsg.message?.length))) {
      replyMsg = (await this._fetchMessageById(e, id)) || replyMsg;
    }

    const parts = this._segmentsToHistoryParts(
      Array.isArray(replyMsg?.message) ? replyMsg.message : []
    );
    let summary = parts.text || String(replyMsg?.raw_message || '').replace(/\s+/g, ' ').trim();
    if (!summary) {
      if (parts.hasImage) summary = '[图片]';
      else if (parts.hasFile) summary = '[文件]';
      else summary = '(无文本)';
    }
    if (summary.length > 200) summary = `${summary.slice(0, 200)}…`;

    const uid = replyMsg?.sender?.user_id ?? replyMsg?.user_id ?? '';
    const nickname =
      replyMsg?.sender?.card || replyMsg?.sender?.nickname || replyMsg?.nickname || '未知';
    const line = `${nickname}${uid !== '' ? `(${uid})` : ''}[ID:${id}]: ${summary}`;
    return {
      replyId: id,
      line,
      hasImage: parts.hasImage,
      hasFile: parts.hasFile
    };
  }

  /** 去掉 question 里已拼过的回复装饰，避免与 [引用消息] 块重复 */
  static stripInboundReplyDecorators(text) {
    let s = String(text ?? '');
    s = s.replace(/^\[回复:\d+\]\s*/u, '');
    s = s.replace(/^\[回复[^\]]*的"[^"]*"\]\s*/u, '');
    // processMessageContent：`[回复:id] 昵称「摘要」 `
    s = s.replace(/^\[回复:[^\]]+\]\s+[^\n「]*「[^」]*」\s*/u, '');
    return s.trim();
  }

  /**
   * 组装 [当前消息] 文本行（含引用强调）
   * @returns {Promise<{ text: string, images: string[], replyImages: string[] }|null>}
   */
  async _buildCurrentMessagePayload(e, userMessage) {
    if (!e || !userMessage) return null;
    const currentMsgId = ChatStream.resolveEventMessageId(e) || '未知';
    const currentUserNickname = e.sender?.card || e.sender?.nickname || e.user?.name || '用户';
    const rawContent =
      typeof userMessage.content === 'string'
        ? userMessage.content
        : (userMessage.content?.text ?? '');
    const body = ChatStream.stripInboundReplyDecorators(rawContent);

    let images =
      typeof userMessage.content === 'object' && userMessage.content
        ? [...(userMessage.content.images || [])]
        : [];
    let replyImages =
      typeof userMessage.content === 'object' && userMessage.content
        ? [...(userMessage.content.replyImages || [])]
        : [];

    const inboundParts = this._segmentsToHistoryParts(Array.isArray(e.message) ? e.message : []);
    if (
      (inboundParts.hasImage || (Array.isArray(e.img) && e.img.length > 0)) &&
      images.length === 0 &&
      replyImages.length === 0
    ) {
      const extracted = await this._extractImagesFromEvent(e);
      images = extracted.images || [];
      replyImages = extracted.replyImages || [];
      if (images.length === 0 && replyImages.length === 0) {
        RuntimeUtil.makeLog(
          'warn',
          '[ChatStream] 当前消息标记含图但未能解析图片引用，多模态将不可用',
          'ChatStream'
        );
      }
    }

    const hasMedia = images.length > 0 || replyImages.length > 0;
    const replyCtx = await this._resolveInboundReplyContext(e);

    const lineBody =
      body ||
      (hasMedia || inboundParts.hasImage || inboundParts.hasFile ? '[附图]' : replyCtx ? '' : '');
    if (!lineBody && !hasMedia && !replyCtx && !inboundParts.hasFile) return null;

    const tags = [
      hasMedia || replyCtx?.hasImage || inboundParts.hasImage ? '[含图片]' : '',
      replyCtx?.hasFile || inboundParts.hasFile ? '[含文件]' : ''
    ]
      .filter(Boolean)
      .join('');
    const tagPrefix = tags ? `${tags} ` : '';
    const replyMark = replyCtx ? `[回复:${replyCtx.replyId}]` : '';

    const lines = ['[当前消息]'];
    if (replyCtx) {
      lines.push(`[引用消息] ${replyCtx.line}`);
    }
    if (currentMsgId !== '未知') {
      lines.push(
        `${tagPrefix}${currentUserNickname}(${e.user_id})[ID:${currentMsgId}]${replyMark}: ${lineBody || '(仅引用/媒体)'}`
      );
    } else {
      lines.push(`${tagPrefix}${lineBody || '(仅引用/媒体)'}`);
    }

    return {
      text: lines.join('\n'),
      images,
      replyImages
    };
  }

  /**
   * 注册所有功能
   * 
   * 所有功能都通过 MCP 工具提供
   */
  registerAllFunctions() {
    // 群聊 @ 用 reply content 内 `[at:QQ]`，勿单独发空 @（已删无意义 at 工具）

    this.registerMCPTool('poke', {
      description: '戳一戳对方（QQ 系统戳一戳，用户可见）。群聊戳成员，私聊戳好友。qq 不填则当前说话人。禁止用文字 *戳戳* 代替本工具。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: { type: 'string', description: '要戳的对象QQ/用户ID（可选，默认当前用户）' }
        },
        required: []
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e) return { success: false, error: '缺少事件上下文' };
        const targetQq = String(args.qq || e.user_id || e.device_id || '').trim();
        if (!targetQq) return { success: false, error: '无法确定要戳的对象' };

        return this._wrapHandler(async () => {
          const where = formatSessionWhere(e);
          if (e.isGroup === true && e.group?.pokeMember) {
            await e.group.pokeMember(targetQq);
          } else if (e.friend?.poke && String(e.user_id) === targetQq) {
            await e.friend.poke();
          } else if (e.bot?.sendApi) {
            const qqNum = parseInt(targetQq, 10);
            const params = e.group_id != null
              ? { group_id: e.group_id, user_id: qqNum }
              : { user_id: qqNum };
            await e.bot.sendApi('send_poke', params);
          } else if (typeof e.reply === 'function') {
            await e.reply({ type: 'poke', qq: targetQq });
          } else {
            return { success: false, error: '当前环境不支持戳一戳' };
          }
          return { success: true, raw: actionAck(`你已对 ${targetQq} 戳一戳（${where}）`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('emotion', {
      description: `发表情包图片（resources/aiimages/{分类}/ 随机一张）。emotionType：${formatEmotionTypeList()}。text 可选附言，支持 [回复:消息ID] 与 | 分句（图与回复仅随第一条）。用户只要表情时不要填 text。`,
      inputSchema: {
        type: 'object',
        properties: {
          emotionType: { type: 'string', enum: EMOTION_TYPES },
          text: { type: 'string', description: '可选附言' },
        },
        required: ['emotionType'],
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e?.reply) return { success: false, error: '当前环境无法发送' };
        const t = normalizeEmotionType(args.emotionType);
        if (!EMOTION_TYPES.includes(t)) return { success: false, error: '无效表情类型' };
        const image = this.getRandomEmotionImage(t);
        if (!image) {
          return { success: false, error: `暂无「${t}」表情包资源，请检查 resources/aiimages/${t}/` };
        }
        return this._wrapHandler(async () => {
          const text = String(args.text ?? '').trim();
          if (text) {
            const forbidden = replyContentForbidden(text);
            if (forbidden) return { success: false, error: forbidden };
            const parts = splitProtocolParts(text);
            let displayJoined = '';
            for (let i = 0; i < parts.length; i++) {
              const { replyId, segments, displayText } = resolveOutgoingMessage(parts[i], {
                fallbackReplyId: null
              });
              const payload = buildOutboundSegments({
                replyId: i === 0 ? replyId : null,
                imagePaths: i === 0 ? [image] : [],
                segments
              });
              if (!payload.length) continue;
              await e.reply(payload);
              if (displayText) displayJoined = displayJoined ? `${displayJoined} | ${displayText}` : displayText;
            }
            const where = formatSessionWhere(e);
            this.recordAIResponse(e, `[表情:${t}]${displayJoined ? ` ${displayJoined}` : ''}`);
            return { success: true, raw: actionAck(`你已在${where}发送「${t}」表情包`) };
          }
          await e.reply(msgSegment.image(image));
          const where = formatSessionWhere(e);
          this.recordAIResponse(e, `[表情:${t}]`);
          return { success: true, raw: actionAck(`你已在${where}发送「${t}」表情包`) };
        });
      },
      enabled: true,
    });

    this.registerMCPTool('send_file', {
      description: '向当前会话发送非图片类文件（文档、压缩包等）。filePath 为工作区内相对路径；图片请用 send_image。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '工作区内文件路径' },
          name: { type: 'string', description: '可选，客户端显示的文件名' },
        },
        required: ['filePath'],
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const resolved = this._resolveWorkspaceFile(context, args.filePath, { rejectImage: true });
        if (resolved.error) return { success: false, error: resolved.error };
        return this._wrapHandler(async () => {
          const displayName = String(args.name ?? resolved.displayName).trim() || resolved.displayName;
          const sender = e?.group_id ? e.group : e?.friend;
          if (!sender?.sendFile) {
            return { success: false, error: '当前环境不支持发送文件' };
          }
          await sender.sendFile(resolved.absPath, displayName);
          const where = formatSessionWhere(e);
          this.recordAIResponse(e, `[文件:${displayName}]`);
          return { success: true, raw: actionAck(`你已在${where}发送文件「${displayName}」`) };
        });
      },
      enabled: true,
    });

    this.registerMCPTool('send_image', {
      description: '向当前会话发送工作区内的图片（PNG/JPG/GIF 等）。filePath 为工作区相对路径；内置表情包用 emotion。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '工作区内图片路径' },
          messageId: { type: 'string', description: '可选，回复某条消息 ID' },
        },
        required: ['filePath'],
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const resolved = this._resolveWorkspaceFile(context, args.filePath, { requireImage: true });
        if (resolved.error) return { success: false, error: resolved.error };
        if (!e?.reply) return { success: false, error: '当前环境无法发送消息' };
        return this._wrapHandler(async () => {
          const mid = args.messageId != null ? String(args.messageId).trim() : '';
          const payload = [];
          if (mid) payload.push({ type: 'reply', id: mid });
          payload.push(msgSegment.image(resolved.absPath));
          await e.reply(payload);
          const where = formatSessionWhere(e);
          this.recordAIResponse(e, `[图片:${resolved.displayName}]`);
          return { success: true, raw: actionAck(`你已在${where}发送图片「${resolved.displayName}」`) };
        });
      },
      enabled: true,
    });

    this.registerMCPTool('saveMessageAsset', {
      description:
        '将消息中的图片/文件/自定义表情包下载到 Agent 工作区 downloads/。messageId 必填（见 [ID:xxx] 或 [引用消息]）；index 默认 0（文件与图片同一列表）；saveAs 可选相对路径。成功后：图用 send_image，其它用 send_file。勿口头声称已保存。',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: '消息 ID（可保存引用目标或当前消息）' },
          index: { type: 'number', description: '可下载资源序号，默认 0' },
          saveAs: { type: 'string', description: '工作区内相对路径，默认 downloads/qq/{msgId}_{index}.ext' }
        },
        required: ['messageId']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e) return { success: false, error: '事件对象不存在' };
        const msgId = String(args.messageId ?? '').trim();
        if (!msgId) return { success: false, error: '消息ID不能为空' };
        const index = Math.max(parseInt(args.index, 10) || 0, 0);
        const messageData = await this._fetchMessageById(e, msgId);
        if (!messageData) {
          return { success: false, error: '无法获取消息，可能已过期' };
        }
        const segments = Array.isArray(messageData.message) ? messageData.message : [];
        const assets = this._extractMessageAssets(segments).filter(
          (a) => ['image', 'file', 'mface', 'video', 'record'].includes(a.type)
        );
        if (assets.length === 0) {
          return { success: false, error: '该消息没有可下载的图片/视频/语音/文件/表情包' };
        }
        if (index >= assets.length) {
          return { success: false, error: `index 超出范围，共 ${assets.length} 个可下载资源` };
        }
        const asset = assets[index];
        const ext = this._guessAssetExtension(asset);
        const defaultName = asset.name || `qq_${msgId}_${index}${ext}`;
        const relPath =
          String(args.saveAs ?? '').trim() || path.posix.join('downloads', 'qq', defaultName);
        try {
          const absPath = await this._downloadMessageAssetToWorkspace(e, asset, relPath);
          const data = {
            messageId: msgId,
            index,
            type: asset.type,
            workspacePath: relPath,
            absolutePath: absPath
          };
          const hint =
            asset.type === 'image' || asset.type === 'mface'
              ? `已保存到 ${relPath}。发图用 send_image；内置表情包用 emotion。`
              : `已保存到 ${relPath}。当前会话发文件用 send_file；私聊传文件用 relayPrivateFile。`;
          return { success: true, data, raw: hint };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('relayPrivate', {
      description: '向指定好友私聊传话（不在当前群露出正文）。qq 须为好友；content 支持 | 分句。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: { type: 'number', description: '目标好友 QQ' },
          content: { type: 'string', description: '私聊正文' }
        },
        required: ['qq', 'content']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const picked = await this._pickFriendSender(e, args.qq);
        if (picked.error) return this._relayPrivateFail(String(args.qq ?? ''), picked.error);
        const rawContent = String(args.content ?? '').trim();
        if (!rawContent) return { success: false, error: 'content 不能为空' };
        const forbidden = replyContentForbidden(rawContent);
        if (forbidden) return { success: false, error: forbidden };
        return this._wrapRelayPrivateHandler(picked.targetQq, async () => {
          const { totalSent, allSentContent } = await this._relayPrivateOutbound(picked.friend, {
            content: rawContent
          });
          if (totalSent < 1) return { success: false, error: '未能向好友发出任何私聊消息' };
          return {
            success: true,
            raw: this._relayPrivateAck(e, picked, `私聊发出 ${totalSent} 条：${allSentContent.join(' | ')}`)
          };
        });
      },
      enabled: true
    });

    this.registerMCPTool('relayPrivateImage', {
      description: '向好友私聊发送工作区图片。qq、filePath 必填；text 可选附言。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: { type: 'number' },
          filePath: { type: 'string' },
          text: { type: 'string' }
        },
        required: ['qq', 'filePath']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const picked = await this._pickFriendSender(e, args.qq);
        if (picked.error) return this._relayPrivateFail(String(args.qq ?? ''), picked.error);
        const resolved = this._resolveWorkspaceFile(context, args.filePath, { requireImage: true });
        if (resolved.error) return { success: false, error: resolved.error };
        return this._wrapRelayPrivateHandler(picked.targetQq, async () => {
          const sendResult = await this._relayPrivateImageSend(picked.friend, resolved.absPath, args.text);
          if (sendResult.error) return { success: false, error: sendResult.error };
          return {
            success: true,
            raw: this._relayPrivateAck(e, picked, `私聊发送图片「${resolved.displayName}」`)
          };
        });
      },
      enabled: true
    });

    this.registerMCPTool('relayPrivateFile', {
      description: '向好友私聊发送工作区非图片文件。qq、filePath 必填。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: { type: 'number' },
          filePath: { type: 'string' },
          name: { type: 'string' },
          text: { type: 'string' }
        },
        required: ['qq', 'filePath']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const picked = await this._pickFriendSender(e, args.qq);
        if (picked.error) return this._relayPrivateFail(String(args.qq ?? ''), picked.error);
        const resolved = this._resolveWorkspaceFile(context, args.filePath, { rejectImage: true });
        if (resolved.error) return { success: false, error: resolved.error };
        return this._wrapRelayPrivateHandler(picked.targetQq, async () => {
          const displayName = String(args.name ?? resolved.displayName).trim() || resolved.displayName;
          const sendResult = await this._relayPrivateFileSend(
            picked.friend, resolved.absPath, displayName, args.text
          );
          if (sendResult.error) return { success: false, error: sendResult.error };
          return {
            success: true,
            raw: this._relayPrivateAck(e, picked, `私聊发送文件「${displayName}」`)
          };
        });
      },
      enabled: true
    });

    this.registerMCPTool('relayPrivateEmotion', {
      description: `向好友私聊发表情包（resources/aiimages）。qq 必填；emotionType：${formatEmotionTypeList()}；text 可选附言，支持 | 分句（图仅第一条）。`,
      inputSchema: {
        type: 'object',
        properties: {
          qq: { type: 'number' },
          emotionType: { type: 'string', enum: EMOTION_TYPES },
          text: { type: 'string' }
        },
        required: ['qq', 'emotionType']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const picked = await this._pickFriendSender(e, args.qq);
        if (picked.error) return this._relayPrivateFail(String(args.qq ?? ''), picked.error);
        const t = normalizeEmotionType(args.emotionType);
        if (!EMOTION_TYPES.includes(t)) return { success: false, error: '无效表情类型' };
        const image = this.getRandomEmotionImage(t);
        if (!image) {
          return {
            success: false,
            error: `表情包(${t})暂无图片，请检查 resources/aiimages/${t}/`
          };
        }
        return this._wrapRelayPrivateHandler(picked.targetQq, async () => {
          const sendResult = await this._relayPrivateImageSend(picked.friend, image, args.text);
          if (sendResult.error) return { success: false, error: sendResult.error };
          const displayText = sendResult.allSentContent?.join(' | ') || '';
          const summary = displayText
            ? `表情包(${t}) 与附言「${displayText}」`
            : `表情包(${t})`;
          return {
            success: true,
            raw: this._relayPrivateAck(e, picked, `私聊发出${summary}`)
          };
        });
      },
      enabled: true
    });

    this.registerMCPTool('reply', {
      description:
        '向当前会话发文字（立即到 QQ）。群聊要@人：优先 atSender=true（@刚才说话的人），或 at="QQ号"；也可 content 写 [at:QQ]。禁止手写 @昵称 / [CQ:at]。默认不引用；要引用气泡时写 [回复:消息ID] 或填 messageId。| 分句。表情用 emotion。',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '正文（必填）。普通说话不要写 [回复:…]；不要手写 @昵称' },
          messageId: {
            type: 'string',
            description: '仅在要引用某条消息时填写；省略则不引用',
          },
          atSender: {
            type: 'boolean',
            description: '群聊：true=@当前这条消息的发送者（最常用，不用记 QQ）',
          },
          at: {
            type: 'string',
            description: '群聊：要@的 QQ，多个用逗号分隔，如 "123456,789012"',
          },
        },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const turn = this._getTurnState(context);
        const rawContent = prependReplyAtMarkers(
          String(args.content ?? '').trim(),
          collectReplyAtQqs(args, e),
        );
        if (!rawContent) return { success: false, error: 'content 不能为空' };

        const forbidden = replyContentForbidden(rawContent);
        if (forbidden) return { success: false, error: forbidden };
        if (contentHasGroupAt(rawContent) && !e?.isGroup) {
          return { success: false, error: '[at:QQ] / at 参数仅群聊可用' };
        }

        // 仅显式 messageId / content 内 [回复:ID] 才挂引用；绝不默认挂 [当前消息]
        const explicitMid = args.messageId != null ? String(args.messageId).trim() : '';
        const { replyId, displayText } = resolveOutgoingMessage(rawContent, {
          fallbackReplyId: explicitMid || null
        });
        const where = formatSessionWhere(e);
        if (turn.replyFlushed || turn.queuedReplyContent) {
          const prev = turn.lastOutboundSummary
            || resolveOutgoingMessage(turn.queuedReplyContent || '', {
              fallbackReplyId: turn.queuedReplyMessageId
            }).displayText;
          if (isOverlappingUserVisible(displayText, prev)) {
            return {
              success: true,
              raw: formatUserVisibleDuplicateAck(where, `回复「${prev}」`, 'reply')
            };
          }
        }

        if (!e?.reply) return { success: false, error: '当前环境无法发送消息' };

        try {
          // 已解析的 replyId（显式或 content 内 [回复:…]）；无则不挂引用
          await this.sendMessages(e, rawContent, { fallbackReplyId: replyId });
        } catch (err) {
          return { success: false, error: err?.message || '发送失败' };
        }

        turn.queuedReplyContent = rawContent;
        turn.queuedReplyMessageId = replyId;
        turn.replyFlushed = true;
        turn.lastOutboundSummary = displayText || rawContent;
        this.recordAIResponse(e, displayText || rawContent);
        return {
          success: true,
          raw: formatReplySentAck(where, displayText, replyId)
        };
      },
      enabled: true
    });

    this.registerMCPTool('emojiReaction', {
      description: `对群消息表情回应。emojiType：${formatEmotionTypeList(EMOJI_REACTION_TYPES)}。msgId 不填则最近一条他人消息。仅群聊。`,
      inputSchema: {
        type: 'object',
        properties: {
          msgId: { type: 'string', description: '要回应的消息 ID（可选）' },
          emojiType: {
            type: 'string',
            description: '表情类型',
            enum: EMOJI_REACTION_TYPES,
          },
        },
        required: ['emojiType'],
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        if (!e?.isGroup) return { success: false, error: '非群聊环境' };

        const emojiType = normalizeEmotionType(args.emojiType, EMOJI_REACTION_ALIASES);
        const emojiIds = getEmojiReactionIds(emojiType);
        if (!emojiIds?.length) return { success: false, error: '无效表情类型' };

        let msgId = String(args.msgId ?? '').trim();
        if (!msgId) {
          const historyKey = ChatStream.getEventHistoryKey(e);
          const history = historyKey ? (ChatStream.messageHistory.get(historyKey) || []) : [];
          const last = [...history].reverse().find(
            (m) => String(m.user_id) !== String(e.self_id) && m.message_id,
          );
          if (last) msgId = String(last.message_id);
        }
        if (!msgId) return { success: false, error: '找不到可回应的消息 ID' };

        const emojiId = Number(emojiIds[Math.floor(Math.random() * emojiIds.length)]);
        try {
          if (e.group?.setEmojiLike) {
            await e.group.setEmojiLike(msgId, emojiId, true);
          } else if (e.bot?.sendApi) {
            await e.bot.sendApi('set_msg_emoji_like', {
              message_id: String(msgId),
              emoji_id: emojiId,
              set: true
            });
          } else {
            return { success: false, error: '表情回应功能不可用' };
          }
          await RuntimeUtil.sleep(200);
          const gid = e.group_id;
          return {
            success: true,
            raw: actionAck(`你已在群 ${gid} 对消息 ${msgId} 发送了 ${emojiType} 表情回应。`),
            data: { msgId, emojiId, emojiType }
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true,
    });

    this.registerMCPTool('thumbUp', {
      description: '给群成员点赞',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要点赞的成员QQ号'
          },
          count: {
            type: 'number',
            description: '点赞次数（1-50）',
            default: 1
          }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        const thumbCount = Math.min(parseInt(args.count) || 1, 50);
          const member = context.e.group?.pickMember(args.qq);
        if (!member || typeof member.thumbUp !== 'function') {
          return { success: false, error: '点赞功能不可用' };
        }

        return this._wrapHandler(async () => {
          await member.thumbUp(thumbCount);
          return { success: true, message: '点赞成功', data: { qq: args.qq, count: thumbCount } };
        });
      },
      enabled: true
    });

    this.registerMCPTool('mute', {
      description: '禁言群成员。需要管理员或群主权限。仅群聊环境可用。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要禁言的成员QQ号'
          },
          duration: {
            type: 'number',
            description: '禁言时长（秒）'
          }
        },
        required: ['qq', 'duration']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteMember(args.qq, args.duration);
          return { success: true, message: '禁言成功', data: { qq: args.qq, duration: args.duration } };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unmute', {
      description: '解除禁言',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要解禁的成员QQ号'
          }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteMember(args.qq, 0);
          return { success: true, message: '解禁成功', data: { qq: args.qq } };
        });
      },
      enabled: true
    });

    this.registerMCPTool('muteAll', {
      description: '全员禁言',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteAll(true);
          return { success: true, message: '全员禁言成功' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unmuteAll', {
      description: '解除全员禁言',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.muteAll(false);
          return { success: true, message: '解除全员禁言成功' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setCard', {
      description: '修改群名片。未指定QQ号时默认修改机器人自己的名片。需要管理员或群主权限。仅群聊环境可用。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '成员QQ号'
          },
          card: {
            type: 'string',
            description: '新名片'
          }
        },
        required: ['card']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
          const e = context.e;
          let targetQq = String(args.qq || '').trim();
          if (!targetQq) {
            targetQq = String(e.self_id || e.bot?.uin || '').trim() || String(e.user_id || '').trim();
          }
          if (!targetQq) {
            return { success: false, error: '无法确定要修改名片的成员QQ号' };
          }

        return this._wrapHandler(async () => {
          await context.e.group.setCard(targetQq, args.card);
          return { success: true, message: '修改名片成功', data: { qq: targetQq, card: args.card } };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setGroupName', {
      description: '修改群名',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '新群名'
          }
        },
        required: ['name']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setName(args.name);
          return { success: true, message: '修改群名成功', data: { name: args.name } };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setGroupAvatar', {
      description:
        '将工作区内图片设为当前群头像。filePath 为工作区相对路径（如 downloads/xxx.png）。仅群聊；发言者须群主/管理员或主人；机器人须有群管权限。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '工作区内图片路径（PNG/JPG/GIF/WEBP/BMP）',
          },
        },
        required: ['filePath'],
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = await this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;

        const e = context.e;
        const speakerOk =
          e.isMaster === true ||
          e.sender?.role === 'owner' ||
          e.sender?.role === 'admin' ||
          e.member?.is_owner === true ||
          e.member?.is_admin === true;
        if (!speakerOk) {
          return { success: false, error: '需要群主、管理员或主人才能设置群头像' };
        }

        if (typeof e.group?.setAvatar !== 'function') {
          return { success: false, error: '当前环境不支持设置群头像' };
        }

        const resolved = this._resolveWorkspaceFile(context, args.filePath, { requireImage: true });
        if (resolved.error) return { success: false, error: resolved.error };

        return this._wrapHandler(async () => {
          await e.group.setAvatar(resolved.absPath);
          return {
            success: true,
            message: '设置群头像成功',
            data: { filePath: String(args.filePath).trim(), group_id: e.group_id },
            raw: actionAck(`你已将工作区图片「${resolved.displayName}」设为群 ${e.group_id} 的头像。`),
          };
        });
      },
      enabled: true,
    });

    this.registerMCPTool('setAdmin', {
      description: '设置管理员',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '成员QQ号'
          }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setAdmin(args.qq, true);
          return { success: true, message: '设置管理员成功', data: { qq: args.qq } };
        });
      },
      enabled: true
    });

    this.registerMCPTool('unsetAdmin', {
      description: '取消管理员',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '成员QQ号'
          }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setAdmin(args.qq, false);
          return { success: true, message: '取消管理员成功', data: { qq: args.qq } };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setTitle', {
      description: '设置专属头衔',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '成员QQ号'
          },
          title: {
            type: 'string',
            description: '头衔名称'
          },
          duration: {
            type: 'number',
            description: '持续时间（秒）',
            default: -1
          }
        },
        required: ['qq', 'title']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.setTitle(args.qq, args.title, args.duration || -1);
          return { success: true, message: '设置头衔成功', data: { qq: args.qq, title: args.title } };
        });
      },
      enabled: true
    });

    this.registerMCPTool('kick', {
      description: '踢出群成员',
      inputSchema: {
        type: 'object',
        properties: {
          qq: {
            type: 'string',
            description: '要踢出的成员QQ号'
          },
          reject: {
            type: 'boolean',
            description: '是否拒绝再次申请',
            default: false
          }
        },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          await context.e.group.kickMember(args.qq, args.reject || false);
          return { success: true, message: '踢出成员成功', data: { qq: args.qq } };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setEssence', {
      description: '设置精华消息',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: {
            type: 'string',
            description: '消息ID'
          }
        },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) {
          return { success: false, error: '消息ID不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          if (group && typeof group.setEssenceMessage === 'function') {
            await group.setEssenceMessage(msgId);
            return { success: true, message: '设置精华成功', data: { msgId } };
          } else if (context.e.bot?.sendApi) {
            await context.e.bot.sendApi('set_essence_msg', { message_id: msgId });
            return { success: true, message: '设置精华成功', data: { msgId } };
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('removeEssence', {
      description: '取消精华消息',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: {
            type: 'string',
            description: '消息ID'
          }
        },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) {
          return { success: false, error: '消息ID不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          if (group && typeof group.removeEssenceMessage === 'function') {
            await group.removeEssenceMessage(msgId);
            return { success: true, message: '取消精华成功', data: { msgId } };
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('announce', {
      description: '发送群公告',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '公告内容'
          },
          image: {
            type: 'string',
            description: '公告图片URL（可选）'
          }
        },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        const content = String(args.content ?? '').trim();
        if (!content) {
          return { success: false, error: '公告内容不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          const image = args.image ? String(args.image).trim() : undefined;
          
          if (group && typeof group.sendNotice === 'function') {
            const result = await group.sendNotice(content, image ? { image } : {});
            if (result !== undefined) {
              return { success: true, message: '发送群公告成功', data: { content } };
            }
          } else if (context.e.bot?.sendApi) {
            const apiParams = { group_id: context.e.group_id, content };
            if (image) apiParams.image = image;
            const result = await context.e.bot.sendApi('_send_group_notice', apiParams);
            if (result?.status === 'ok') {
              return { success: true, message: '发送群公告成功', data: { content } };
            }
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('recall', {
      description: '撤回消息',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: {
            type: 'string',
            description: '要撤回的消息ID'
          }
        },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        if (!context.e) {
          return { success: false, error: '事件对象不存在' };
        }
        
        try {
          let canRecall = false;
          let messageInfo = null;
          
          if (context.e.bot && context.e.bot.sendApi) {
            try {
              messageInfo = await context.e.bot.sendApi('get_msg', { message_id: args.msgId });
            } catch {
              // 忽略获取消息信息失败
            }
          }
          
          if (context.e.isGroup) {
            const botRole = await this.getBotRole(context.e);
            const isAdmin = botRole === '管理员' || botRole === '群主';
            
            if (messageInfo && messageInfo.data) {
              const msgData = messageInfo.data;
              const isSelfMsg = String(msgData.sender?.user_id) === String(context.e.self_id);
              const msgTime = msgData.time || 0;
              const currentTime = Math.floor(Date.now() / 1000);
              const timeDiff = currentTime - msgTime;
              
              if (isSelfMsg && timeDiff <= 180) {
                canRecall = true;
              } else if (isAdmin) {
                canRecall = true;
              } else {
                return { success: false, error: isSelfMsg ? '消息已超过3分钟' : '需要管理员权限' };
              }
            } else if (isAdmin) {
              canRecall = true;
            }
          } else {
            if (messageInfo && messageInfo.data) {
              const msgData = messageInfo.data;
              const isSelfMsg = String(msgData.sender?.user_id) === String(context.e.self_id);
              const msgTime = msgData.time || 0;
              const currentTime = Math.floor(Date.now() / 1000);
              const timeDiff = currentTime - msgTime;
              
              if (isSelfMsg && timeDiff <= 180) {
                canRecall = true;
              } else {
                return { success: false, error: isSelfMsg ? '已超过3分钟' : '不是自己的消息' };
              }
            } else {
              canRecall = true;
            }
          }
          
          if (!canRecall) {
            return { success: false, error: '无法撤回消息' };
          }

          return this._wrapHandler(async () => {
            if (context.e.isGroup && context.e.group) {
              await context.e.group.recallMsg(args.msgId);
            } else if (context.e.bot) {
              await context.e.bot.sendApi('delete_msg', { message_id: args.msgId });
            }
            return { success: true, message: '消息撤回成功', data: { msgId: args.msgId } };
          });
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getBanList', {
      description: '获取当前被禁言的成员列表',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        return this._wrapHandler(async () => {
          const group = context.e.group;
          if (group && typeof group.getBanList === 'function') {
            const banList = await group.getBanList();
            RuntimeUtil.makeLog('debug', `群禁言列表: ${JSON.stringify(banList)}`, 'ChatStream');
            return { success: true, data: banList };
          }
          return { success: false, error: 'API不可用' };
        }, 0).catch(error => {
          RuntimeUtil.makeLog('warn', `获取禁言列表失败: ${error.message}`, 'ChatStream');
          return { success: false, error: error.message };
        });
      },
      enabled: true
    });

    this.registerMCPTool('setGroupTodo', {
      description: '设置群代办',
      inputSchema: {
        type: 'object',
        properties: {
          msgId: {
            type: 'string',
            description: '消息ID'
          }
        },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) {
          return { success: false, error: '消息ID不能为空' };
        }
        
        return this._wrapHandler(async () => {
          const e = context.e;
          const botRole = await this.getBotRole(e);
          const isAdmin = botRole === '管理员' || botRole === '群主';
          if (!isAdmin) {
            return { success: false, error: '需要管理员或群主权限才能设置群代办' };
          }

          if (e.bot?.sendApi) {
            await e.bot.sendApi('set_group_todo', {
              group_id: e.group_id,
              message_id: msgId
            });
            return { success: true, raw: actionAck(`你已在群 ${e.group_id} 将消息 ${msgId} 设为群待办。`) };
          }
          return { success: false, error: 'API不可用' };
        });
      },
      enabled: true
    });

    this.registerMCPTool('completeGroupTodo', {
      description: '完成群待办。msgId 必填。仅群聊，需管理权限。',
      inputSchema: {
        type: 'object',
        properties: { msgId: { type: 'number' } },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = await this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) return { success: false, error: '消息ID不能为空' };
        return this._wrapHandler(async () => {
          const e = context.e;
          if (e.group?.completeTodo) await e.group.completeTodo(msgId);
          else await e.bot.sendApi('complete_group_todo', { group_id: e.group_id, message_id: msgId });
          return { success: true, raw: actionAck(`你已在群 ${e.group_id} 完成消息 ${msgId} 的群待办。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('cancelGroupTodo', {
      description: '取消群待办。msgId 必填。仅群聊，需管理权限。',
      inputSchema: {
        type: 'object',
        properties: { msgId: { type: 'number' } },
        required: ['msgId']
      },
      handler: async (args = {}, context = {}) => {
        const adminCheck = await this._requireGroupAdmin(context);
        if (adminCheck) return adminCheck;
        const msgId = String(args.msgId ?? '').trim();
        if (!msgId) return { success: false, error: '消息ID不能为空' };
        return this._wrapHandler(async () => {
          const e = context.e;
          if (e.group?.cancelTodo) await e.group.cancelTodo(msgId);
          else await e.bot.sendApi('cancel_group_todo', { group_id: e.group_id, message_id: msgId });
          return { success: true, raw: actionAck(`你已在群 ${e.group_id} 取消消息 ${msgId} 的群待办。`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('listAnnouncements', {
      description: '获取当前群公告列表。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        const e = context.e;
        let data;
        if (e.group?.getAnnouncements) data = await e.group.getAnnouncements();
        else data = await e.bot.sendApi('_get_group_notice', { group_id: String(e.group_id) });
        return { success: true, raw: this._queryToolRawDetail('群公告列表', data, e), data };
      },
      enabled: true
    });

    this.registerMCPTool('getGroupInfo', {
      description: '获取群基础信息（群名、群号、成员数等）。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        const e = context.e;
        try {
          let info = null;
          if (typeof e.group?.getInfo === 'function') info = await e.group.getInfo();
          else if (e.bot?.sendApi) {
            const result = await e.bot.sendApi('get_group_info', { group_id: e.group_id });
            info = result?.data || result || null;
          }
          if (!info) return { success: false, error: '无法获取群信息' };
          return { success: true, data: info, raw: this._queryToolRawDetail('群基础信息', info, e) };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getMemberInfo', {
      description: '获取群成员信息。qq 必填。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        const e = context.e;
        const qq = String(args.qq ?? '').trim();
        if (!qq) return { success: false, error: 'QQ号不能为空' };
        try {
          let info = null;
          const member = e.group?.pickMember?.(qq);
          if (member && typeof member.getInfo === 'function') info = await member.getInfo();
          if (!info && e.bot?.sendApi) {
            const result = await e.bot.sendApi('get_group_member_info', {
              group_id: e.group_id,
              user_id: qq
            });
            info = result?.data || result || null;
          }
          if (!info) return { success: false, error: '无法获取成员信息' };
          return {
            success: true,
            data: info,
            raw: this._queryToolRawDetail(`成员 ${qq} 的信息`, info, e)
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getFriendInfo', {
      description: '获取好友/陌生人资料。qq 必填。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number', description: '目标 QQ' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const e = context.e;
        const qq = String(args.qq ?? '').trim();
        if (!qq) return { success: false, error: 'QQ号不能为空' };
        try {
          const bot = e?.bot;
          let info = null;
          const friend = bot?.pickFriend?.(qq);
          if (friend && typeof friend.getInfo === 'function') info = await friend.getInfo();
          if (!info && bot?.sendApi) {
            const result = await bot.sendApi('get_stranger_info', { user_id: qq });
            info = result?.data || result || null;
          }
          if (!info) return { success: false, error: '无法获取好友信息' };
          return { success: true, data: info, raw: this._queryToolRawDetail(`QQ ${qq} 的资料`, info, e) };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('readChatRecord', {
      description:
        '读取当前群结构化聊天记录（本地缓存+适配器同步）。messageId 查单条；limit 默认 30。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: '可选，单条消息 ID' },
          limit: { type: 'number', description: '最近条数 1-50，默认 30' }
        },
        required: []
      },
      handler: async (args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        const e = context.e;
        await this.syncHistoryFromAdapter(e);
        const historyKey = ChatStream.getEventHistoryKey(e);
        const history = ChatStream.messageHistory.get(historyKey) || [];
        const msgId = String(args.messageId ?? '').trim();
        if (msgId) {
          const one = history.find((m) => String(m.message_id || m.real_id) === msgId);
          if (!one) return { success: false, error: '本地历史无此消息，可能已过期' };
          let assets = [];
          const messageData = await this._fetchMessageById(e, msgId);
          if (messageData?.message) {
            assets = this._extractMessageAssets(messageData.message)
              .filter((a) => a.type === 'image' || a.type === 'file' || a.type === 'mface')
              .map((a, index) => ({
                index,
                type: a.type,
                name: a.name || undefined,
                downloadable: true
              }));
          }
          const data = {
            message_id: one.message_id,
            user_id: one.user_id,
            nickname: one.nickname,
            message: one.message,
            time: one.time,
            isBot: one.isBot === true,
            isTool: one.isTool === true,
            hasImage: !!one.hasImage,
            hasFile: !!one.hasFile,
            downloadable: !!(one.hasImage || one.hasFile || assets.length),
            assets
          };
          return {
            success: true,
            data,
            raw: this._queryToolRawDetail(`消息 ${msgId}`, data, e)
          };
        }
        const limit = Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), 50);
        const slice = history.slice(-limit);
        const data = {
          limit,
          count: slice.length,
          messages: slice.map((m) => ({
            message_id: m.message_id || m.real_id,
            user_id: m.user_id,
            nickname: m.nickname,
            message: stripLegacyToolUsagePrefix(m.message || ''),
            time: m.time,
            isBot: m.isBot === true,
            isTool: m.isTool === true,
            hasImage: !!m.hasImage,
            hasFile: !!m.hasFile,
            downloadable: !!(m.hasImage || m.hasFile)
          }))
        };
        return {
          success: true,
          data,
          raw: this._queryToolRawDetail('群聊记录', data, e)
        };
      },
      enabled: true
    });

    this.registerMCPTool('setFriendRemark', {
      description: '设置好友备注。qq、remark 必填。仅主人。',
      inputSchema: {
        type: 'object',
        properties: {
          qq: { type: 'number' },
          remark: { type: 'string' }
        },
        required: ['qq', 'remark']
      },
      handler: async (args = {}, context = {}) => {
        const masterCheck = this._requireMaster(context);
        if (masterCheck) return masterCheck;
        const qq = String(args.qq ?? '').trim();
        const remark = String(args.remark ?? '').trim();
        if (!qq || !remark) return { success: false, error: 'qq 与 remark 必填' };
        return this._wrapHandler(async () => {
          const e = context.e;
          if (e.bot?.sendApi) {
            await e.bot.sendApi('set_friend_remark', { user_id: qq, remark });
          } else {
            const friend = e.bot?.pickFriend?.(qq);
            if (friend?.setRemark) await friend.setRemark(remark);
            else return { success: false, error: '当前适配器不支持设置备注' };
          }
          return { success: true, raw: actionAck(`已将 QQ ${qq} 备注设为「${remark}」`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('deleteFriend', {
      description: '删除好友。qq 必填。仅主人；不可恢复。',
      inputSchema: {
        type: 'object',
        properties: { qq: { type: 'number' } },
        required: ['qq']
      },
      handler: async (args = {}, context = {}) => {
        const masterCheck = this._requireMaster(context);
        if (masterCheck) return masterCheck;
        const qq = String(args.qq ?? '').trim();
        if (!qq) return { success: false, error: 'qq 必填' };
        return this._wrapHandler(async () => {
          const e = context.e;
          if (e.bot?.sendApi) {
            await e.bot.sendApi('delete_friend', { user_id: qq });
          } else {
            const friend = e.bot?.pickFriend?.(qq);
            if (friend?.delete) await friend.delete();
            else return { success: false, error: '当前适配器不支持删除好友' };
          }
          return { success: true, raw: actionAck(`已删除好友 QQ ${qq}`) };
        });
      },
      enabled: true
    });

    this.registerMCPTool('getFriendList', {
      description: '获取当前机器人的好友列表（QQ号、昵称、备注）',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const e = context.e;
        const bot = e?.bot;
        if (!bot || typeof bot.getFriendMap !== 'function') {
          return { success: false, error: '当前适配器不支持获取好友列表' };
        }

        try {
          const map = await bot.getFriendMap();
          const friends = [];
          if (map && typeof map.forEach === 'function') {
            map.forEach((info, uid) => {
              if (!uid) return;
              const qq = String(uid);
              const nickname = info?.nickname || '';
              const remark = info?.remark || '';
              friends.push({ qq, nickname, remark });
            });
          }

          RuntimeUtil.makeLog(
            'debug',
            `[chat.getFriendList] 好友数量: ${friends.length}`,
            'ChatStream'
          );

          return {
            success: true,
            data: { friends }
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('getGroupMembers', {
      description: '列出当前群成员（qq、昵称、名片、角色等）。仅群聊。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;

        const group = context.e.group;
        if (!group) {
          return { success: false, error: '群对象不存在' };
        }

        try {
          // 优先使用 getMemberMap（包含完整信息）
          let memberMap = null;
          if (typeof group.getMemberMap === 'function') {
            memberMap = await group.getMemberMap();
          }

          const members = [];

          if (memberMap && typeof memberMap.forEach === 'function') {
            memberMap.forEach((info, uid) => {
              if (!uid) return;
              const qq = String(uid);
              const role = info?.role || 'member';
              const is_owner = role === 'owner';
              const is_admin = role === 'admin' || role === 'owner';
              members.push({
                qq,
                nickname: info?.nickname || '',
                card: info?.card || '',
                role,
                is_owner,
                is_admin
              });
            });
          } else if (typeof group.getMemberArray === 'function') {
            // 兼容只提供成员数组的情况
            const arr = await group.getMemberArray();
            for (const info of Array.isArray(arr) ? arr : []) {
              if (!info || info.user_id === undefined) continue;
              const qq = String(info.user_id);
              const role = info?.role || 'member';
              const is_owner = role === 'owner';
              const is_admin = role === 'admin' || role === 'owner';
              members.push({
                qq,
                nickname: info?.nickname || '',
                card: info?.card || '',
                role,
                is_owner,
                is_admin
              });
            }
          } else {
            return { success: false, error: '当前适配器不支持获取群成员列表' };
          }

          RuntimeUtil.makeLog(
            'debug',
            `[chat.getGroupMembers] 群 ${e.group_id} 成员数量: ${members.length}`,
            'ChatStream'
          );

          return {
            success: true,
            data: { members }
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('listEssence', {
      description: '列出当前群精华消息。仅群聊。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, context = {}) => {
        const groupCheck = this._requireGroup(context);
        if (groupCheck) return groupCheck;
        const e = context.e;
        try {
          let list = null;
          if (typeof e.group?.getEssence === 'function') {
            list = await e.group.getEssence();
          } else if (typeof e.group?.getEssenceMsg === 'function') {
            list = await e.group.getEssenceMsg();
          } else if (e.bot?.sendApi) {
            const result = await e.bot.sendApi('get_essence_msg_list', { group_id: e.group_id });
            list = result?.data ?? result;
          }
          if (!list) return { success: false, error: '当前适配器不支持拉取精华列表' };
          const data = Array.isArray(list) ? list : list?.messages || list;
          return {
            success: true,
            data: { essence: data },
            raw: this._queryToolRawDetail('群精华消息', data, e)
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('handleRequest', {
      description:
        '处理加好友/加群申请（多面）：action=list 列出 pending；approve/deny 需 flag。仅主人。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'list | approve | deny',
            enum: ['list', 'approve', 'deny']
          },
          flag: { type: 'string', description: '申请 flag（approve/deny 必填）' },
          type: {
            type: 'string',
            description: 'list 时可筛 friend|group',
            enum: ['friend', 'group']
          },
          remark: { type: 'string', description: '通过好友时可设备注' },
          reason: { type: 'string', description: '拒绝加群时可附理由' }
        },
        required: ['action']
      },
      handler: async (args = {}, context = {}) => {
        const masterCheck = this._requireMaster(context);
        if (masterCheck) return masterCheck;
        const e = context.e;
        const bot = e?.bot;
        if (!bot) return { success: false, error: '无机器人实例' };

        const action = String(args.action ?? '').trim().toLowerCase();
        const pending = Array.isArray(bot.request_list) ? bot.request_list : [];

        if (action === 'list') {
          const typeFilter = args.type ? String(args.type).trim() : '';
          const rows = pending
            .filter((r) => r && (!typeFilter || r.request_type === typeFilter))
            .map((r) => ({
              flag: r.flag,
              type: r.request_type,
              sub_type: r.sub_type,
              user_id: r.user_id,
              group_id: r.group_id,
              comment: r.comment || ''
            }));
          return {
            success: true,
            data: { count: rows.length, requests: rows },
            raw: this._queryToolRawDetail('待处理申请', rows, e)
          };
        }

        if (action !== 'approve' && action !== 'deny') {
          return { success: false, error: 'action 须为 list|approve|deny' };
        }

        const flag = String(args.flag ?? '').trim();
        if (!flag) return { success: false, error: 'approve/deny 须提供 flag' };
        const approve = action === 'approve';
        const hit = pending.find((r) => String(r?.flag) === flag);

        return this._wrapHandler(async () => {
          if (hit && typeof hit.approve === 'function') {
            if (hit.request_type === 'friend') {
              await hit.approve(approve, args.remark);
            } else {
              await hit.approve(approve, args.reason);
            }
          } else {
            const asGroup = args.type === 'group' || (hit && hit.request_type === 'group');
            if (asGroup) {
              if (typeof bot.setGroupAddRequest === 'function') {
                await bot.setGroupAddRequest(flag, approve, args.reason, hit?.sub_type || 'add');
              } else if (bot.sendApi) {
                await bot.sendApi('set_group_add_request', {
                  flag,
                  sub_type: hit?.sub_type || 'add',
                  approve,
                  reason: args.reason
                });
              } else {
                return { success: false, error: '当前适配器不支持处理加群申请' };
              }
            } else if (typeof bot.setFriendAddRequest === 'function') {
              await bot.setFriendAddRequest(flag, approve, args.remark);
            } else if (bot.sendApi) {
              await bot.sendApi('set_friend_add_request', {
                flag,
                approve,
                remark: args.remark
              });
            } else {
              return { success: false, error: '当前适配器不支持处理好友申请' };
            }
          }

          if (Array.isArray(bot.request_list)) {
            bot.request_list = bot.request_list.filter((r) => String(r?.flag) !== flag);
          }
          return {
            success: true,
            raw: actionAck(`${approve ? '已通过' : '已拒绝'}申请 flag=${flag}`)
          };
        });
      },
      enabled: true
    });
  }

  /**
   * 获取随机表情
   */
  getRandomEmotionImage(emotion) {
    const images = ChatStream.emotionImages[emotion];
    if (!images || images.length === 0) return null;
    return images[Math.floor(Math.random() * images.length)];
  }

  /**
   * 记录消息到历史，统一使用 getEventHistoryKey 作为 key，群聊/私聊/设备互不冲突；最多保留 50 条。
   */
  recordMessage(e) {
    if (!e) return;
    const historyKey = ChatStream.getEventHistoryKey(e);
    if (!historyKey) return;
    try {
      let message = '';
      let hasImage = !!(Array.isArray(e.img) && e.img.length > 0);
      let hasFile = false;
      let hasFace = false;
      let rawSegments = null;

      if (Array.isArray(e.message)) {
        rawSegments = e.message;
        const parts = this._segmentsToHistoryParts(e.message);
        message = parts.text;
        hasImage = hasImage || parts.hasImage;
        hasFile = parts.hasFile;
        hasFace = parts.hasFace;
        if (!message && e.raw_message) {
          message = String(e.raw_message)
            .replace(/\[CQ:(?:image|file|mface|face)[^\]]*\]/gi, '')
            .trim();
        }
      } else if (e.raw_message) {
        message = e.raw_message;
      } else if (e.msg) {
        message = e.msg;
      } else if (e.message && typeof e.message === 'string') {
        message = e.message;
      } else if (e.content) {
        message = typeof e.content === 'string' ? e.content : (e.content?.text ?? '');
      }

      const userId = e.user_id ?? e.userId ?? e.user?.id ?? e.sender?.user_id ?? null;
      const nickname = e.sender?.card || e.sender?.nickname || e.user?.name || e.user?.nickname || e.from?.name || '未知';
      let messageId = e.message_id ?? e.real_id;
      if (!messageId) {
        messageId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        RuntimeUtil.makeLog('debug', `消息ID缺失，使用临时ID: ${messageId}`, 'ChatStream');
      } else {
        messageId = String(messageId);
      }

      const msgData = {
        user_id: userId,
        nickname,
        message,
        message_id: messageId,
        time: e.time || Date.now(),
        platform: historyPlatform(e),
        hasImage,
        hasFile,
        hasFace,
        ...(rawSegments ? { _rawMessage: rawSegments } : {})
      };

      if (!ChatStream.messageHistory.has(historyKey)) ChatStream.messageHistory.set(historyKey, []);
      const history = ChatStream.messageHistory.get(historyKey);
      // sync 可能已写入同 message_id，避免末尾重复两条
      if (history.some((m) => ChatStream.historyEntryId(m) === messageId)) return;
      history.push(msgData);
      if (history.length > 50) ChatStream.messageHistory.set(historyKey, history.slice(-50));

      if (this.embeddingConfig?.enabled && message && message.length > 5) {
        this.storeMessageMemory(historyKey, msgData).catch(() => {});
      }
    } catch (error) {
      RuntimeUtil.makeLog('debug', `记录消息失败: ${error.message}`, 'ChatStream');
    }
  }

  async getBotRole(e) {
    if (!e.isGroup) return '成员';
    const member = e.group?.pickMember(e.self_id);
    const roleValue = member?.role;
    return roleValue === 'owner' ? '群主' : 
           roleValue === 'admin' ? '管理员' : '成员';
  }

  /**
   * 将本轮对外发出的文本记入会话历史（【我】）。
   * 不写工具名列表——用户已看到 reply 内容；非可视工具走 `recordToolCallResult`。
   *
   * @param {object} e
   * @param {string} text
   */
  recordAIResponse(e, text) {
    if (!text || !text.trim()) return;

    const botName = e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'AgentRuntime';
    const msgData = {
      user_id: e.self_id,
      nickname: botName,
      message: stripLegacyToolUsagePrefix(text),
      message_id: `local_${Date.now()}`,
      time: Date.now(),
      platform: historyPlatform(e),
      isBot: true
    };

    const historyKey = ChatStream.getEventHistoryKey(e);
    if (historyKey) {
      const history = ChatStream.messageHistory.get(historyKey) || [];
      history.push(msgData);
      if (history.length > 50) history.shift();
      ChatStream.messageHistory.set(historyKey, history);
    }
    if (this.embeddingConfig?.enabled && historyKey)
      this.storeMessageMemory(historyKey, msgData).catch(() => {});
  }

  async buildSystemPrompt(context) {
    const { e, question } = context;
    const persona =
      question?.persona ||
      '你是群里一起聊天的伙伴：像真人一样接话，听得懂玩笑和气氛，该正经说清、该闲聊就短打。';
    const botName = e?.bot?.nickname || e?.bot?.info?.nickname || e?.bot?.name || 'AgentRuntime';

    const lines = [
      `# ${botName}`,
      persona,
      '',
      '## 对用户说话（须调 MCP，勿用文字假装）',
      '- **reply**：当前会话文字（调用后立即发到 QQ）。群聊@人：`atSender=true` 或 `at="QQ"`；也可 content 写 `[at:QQ]`。默认不引用；仅要挂引用气泡时才写 `[回复:那条的ID]` 或填 messageId。`|` 分句',
      '- **poke** / **emotion** / **send_image** / **send_file** / **emojiReaction**：戳一戳、表情包、图文件、表情回应',
      '- **saveMessageAsset**：按消息 ID 把图/文件/自定义表情落到工作区 `downloads/`；成功拿到 `workspacePath` 后再 `send_image`/`send_file`',
      '- **relayPrivate***：向好友私聊传话（正文不在群里露出）',
      '',
      '## 群管 / 查询 / 好友（多面能力）',
      '- 群管：mute/unmute、muteAll、setCard、**setGroupAvatar**（工作区图片路径设群头像）、kick、announce、recall、setEssence/listEssence、setGroupTodo 等（无权限如实说明）',
      '- 查询：getGroupInfo / getMemberInfo / getGroupMembers / getBanList / listAnnouncements / **readChatRecord**',
      '- 好友：getFriendList / getFriendInfo；备注与删友（setFriendRemark / deleteFriend）仅主人',
      '- 申请：**handleRequest**（list/approve/deny）处理加好友/加群，仅主人',
      '- **tools.***（须 merge `tools`）：read / grep / search_replace / write / list_files / delete_file / run；陌生仓先 **repo_map**；多文件改用 **apply_edit**，改后 **verify**；多步用 **update_todos**',
      '- 禁止 `@QQ`/`@昵称`；用户已能看见后勿重复 reply；只答 `[当前消息]`',
      '',
      '## 图片与文件',
      '- `[当前消息]` 下若有 `[引用消息]`，表示用户在回复那条；讨论/保存应针对引用目标或当前附图',
      '- `[当前消息]` 附图本轮已多模态可见，勿声称「看不见图」',
      '- 历史行 `[含图片]`/`[含文件]` 仅表示该消息曾带媒体；落盘须 **saveMessageAsset(messageId)**，禁止口头「已保存」',
      '- **send_image** / **send_file** 只能发工作区内已有路径，不能凭空 invent 文件名',
      '- **setGroupAvatar**：工作区内图片路径设为当前群头像（先 saveMessageAsset 或已有文件）',
      '',
      '## 记录',
      '- `昵称(QQ)[ID:xxx]` 中的 ID 可写进 `[回复:xxx]` 或 saveMessageAsset；日常接话可不引用',
      '',
      '## 工作区与 skills',
      '- 「Workspace context」含 AGENTS / rules / **skills**（按 location 用 tools.read 加载）',
      '- triggers 命中的 microagents 会整段注入；其余 skill 按 location 用 tools.read 加载',
      '- 发文件前确认工作区路径存在',
    ];

    const userText = typeof question === 'string'
      ? question
      : (question?.content ?? question?.text ?? e?.msg ?? '');
    return this.finalizeSystemPromptContent(lines.join('\n'), {
      userText: String(userText || '')
    });
  }

  /** 动态轮次上下文（独立 user 消息，不污染可缓存的 system 前缀） */
  _buildVolatileTurnContext(e, question) {
    if (!e) return '';
    const dateStr = question?.dateStr || new Date().toLocaleString('zh-CN');
    const botName = e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'AgentRuntime';
    const botRole = question?.botRole || '';
    const sessionLine = e.isGroup && e.group_id
      ? `${botName}｜QQ ${e.self_id}｜群 ${e.group_id}${botRole ? `｜${botRole}` : ''}`
      : `${botName}｜QQ ${e.self_id}｜私聊 ${e.user_id}`;
    const parts = [`会话：${sessionLine}`, `当前时间：${dateStr}`];
    if (e.isMaster === true) parts.push('当前发言者为主人，指令优先、少反驳。');
    if (question?.isGlobalTrigger) {
      parts.push('【随机旁观】闲看群聊，想接就接一两句；可随意引用或不引用。勿总结全文、勿逐条点评。');
    }
    return `【本轮上下文】\n${parts.join('\n')}`;
  }

  async buildEnhancedContext(e, question, messages) {
    const enhanced = [...messages];
    const ctx = question && typeof question === 'object' ? { ...question } : {};
    if (e && ctx.botRole == null) {
      ctx.botRole = await this.getBotRole(e);
    }
    const volatile = this._buildVolatileTurnContext(e, ctx);
    if (volatile) {
      enhanced.splice(1, 0, { role: 'user', content: volatile });
    }
    return enhanced;
  }

  /** 从消息段取出可用的图片引用（委托标准层） */
  _imageRefFromSegment(seg) {
    const { images } = extractVisionFromSegments(seg ? [seg] : []);
    return images[0] ? visionRefToLocator(images[0]) : null;
  }

  /**
   * 通道无关提取：段 / e.img / getReply → string[]（兼容既有 payload）
   */
  async _extractImagesFromEvent(e) {
    const { images, replyImages } = await extractVisionFromEvent(e, { skipStickers: true });
    const toLocators = (list) =>
      list.map((x) => visionRefToLocator(x)).filter(Boolean);

    const outImages = toLocators(images);
    const outReply = toLocators(replyImages);

    if (
      (Array.isArray(e?.message) &&
        e.message.some((s) => s?.type === 'image' || s?.type === 'mface')) &&
      outImages.length === 0 &&
      outReply.length === 0
    ) {
      RuntimeUtil.makeLog(
        'warn',
        '[ChatStream] 消息含图片段但未能解析引用，多模态将不可用',
        'ChatStream'
      );
    }

    return { images: outImages, replyImages: outReply };
  }

  async buildChatContext(e, question) {
    if (Array.isArray(question)) {
      return question;
    }

    const messages = [];
    messages.push({
      role: 'system',
      content: await this.buildSystemPrompt({ e, question })
    });

    const text = typeof question === 'string'
      ? question
      : (question?.content ?? question?.text ?? '');

    const isGlobalTrigger = !!(question && typeof question === 'object' && question.isGlobalTrigger);
    const { images, replyImages } = await this._extractImagesFromEvent(e);
    const userContent = buildAgtUserContent({
      text: text || '',
      images,
      replyImages,
      extra: isGlobalTrigger ? { isGlobalTrigger: true } : undefined
    });

    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  extractQueryFromMessages(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          return msg.content;
        } else if (msg.content?.text) {
          return msg.content.text;
        }
      }
    }
    return '';
  }

  /**
   * 统一：根据事件得到历史缓存的 key（群=group_id，设备=device_${device_id}，私聊=private_${user_id}）
   */
  static getEventHistoryKey(e) {
    if (!e) return null;
    if (e.isGroup === true && e.group_id != null) return String(e.group_id);
    if (e.isDevice === true && e.device_id) return `device_${e.device_id}`;
    if (e.user_id != null) return `private_${e.user_id}`;
    return null;
  }

  /**
   * 从事件消息段中取“被回复消息”的 id（与 e.getReply() 同源，仅同步取 id）
   * 插件需完整内容/媒体时请用 e.getReply()。
   */
  static getReplySegmentId(e) {
    const seg = e?.message && Array.isArray(e.message) ? e.message.find(s => s && s.type === 'reply') : null;
    const id = segReplyId(seg) || (e?.source?.message_id != null || e?.source?.id != null
      ? String(e.source.message_id ?? e.source.id).trim()
      : '');
    return id || null;
  }

  /** 当前触发消息 ID（NapCat：message_id === real_id；勿用 real_seq / source） */
  static resolveEventMessageId(e) {
    if (!e) return null;
    const id = e.message_id ?? e.real_id;
    const s = id != null ? String(id).trim() : '';
    return s || null;
  }

  /** 历史条目引用 ID（与 resolveEventMessageId 同为 message_id 优先） */
  static historyEntryId(msg) {
    if (!msg) return '';
    const id = msg.message_id ?? msg.real_id;
    return id != null ? String(id).trim() : '';
  }

  /**
   * 统一：解析事件的聊天历史来源，供 syncHistoryFromAdapter / mergeMessageHistory 使用
   * @returns {{ historyKey: string, getter: function } | null}
   */
  getHistorySource(e) {
    const historyKey = ChatStream.getEventHistoryKey(e);
    if (!historyKey) return null;
    // e.getChatHistory 多为已 bind；e.group.getChatHistory 必须 bind，否则 this 丢失会静默空结果
    let getter = null;
    if (typeof e?.getChatHistory === 'function') {
      getter = e.getChatHistory.bind(e);
    } else if (e?.group && typeof e.group.getChatHistory === 'function') {
      getter = e.group.getChatHistory.bind(e.group);
    }
    if (!getter) return null;
    return { historyKey, getter };
  }

  async syncHistoryFromAdapter(e) {
    const source = this.getHistorySource(e);
    if (!source) return;
    const { historyKey, getter } = source;

    try {
      let rawHistory;
      try {
        // 优先使用 (message_seq, count, reverseOrder) 签名，message_seq 为空表示从最近开始
        rawHistory = await getter(undefined, 50, true);
      } catch {
        // 兼容只接受 (count) 的实现
        rawHistory = await getter(50);
      }

      const history = ChatStream.messageHistory.get(historyKey) || [];
      const existingIds = new Set(
        history.map(msg => String(msg.message_id || msg.real_id || ''))
      );

      const newMessages = [];
      for (const msg of Array.isArray(rawHistory) ? rawHistory : []) {
        if (!msg || typeof msg !== 'object') continue;
        const mid = msg.message_id || msg.real_id || msg.message_seq;
        if (!mid) continue;
        const idStr = String(mid);
        if (existingIds.has(idStr)) continue;

        const sender = msg.sender || {};
        const segments = flattenMessageSegs(msg.message);
        const parts = this._segmentsToHistoryParts(segments);
        let text = parts.text;
        if (!text) {
          text = msg.raw_message
            ? String(msg.raw_message)
              .replace(/\[CQ:(?:image|file|mface|face|video|record)[^\]]*\]/gi, '')
              .trim()
            : '';
        }

        const nickname = sender.card || sender.nickname || msg.nickname || '未知';
        const uid = msg.user_id ?? sender.user_id;
        newMessages.push({
          user_id: uid,
          nickname,
          message: stripLegacyToolUsagePrefix(text),
          message_id: idStr,
          time: msg.time || Date.now(),
          platform: historyPlatform(e),
          isBot: e.self_id != null && uid != null && String(uid) === String(e.self_id),
          hasImage: parts.hasImage,
          hasFile: parts.hasFile,
          hasFace: parts.hasFace,
          ...(segments.length ? { _rawMessage: segments } : {})
        });
      }

      if (newMessages.length > 0) {
        const merged = history.concat(newMessages);
        const limited = merged.length > 50 ? merged.slice(-50) : merged;
        ChatStream.messageHistory.set(historyKey, limited);

        RuntimeUtil.makeLog(
          'debug',
          `[ChatStream.syncHistoryFromAdapter] key=${historyKey}, 原有=${history.length}, 新增=${newMessages.length}, 合并后=${limited.length}`,
          'ChatStream'
        );
      }
    } catch (error) {
      RuntimeUtil.makeLog(
        'debug',
        `[ChatStream.syncHistoryFromAdapter] 获取聊天记录失败: ${error.message}`,
        'ChatStream'
      );
    }
  }

  static _shouldRecordToolInHistory(toolName) {
    const base = String(toolName || '').split('.').pop();
    return Boolean(base) && !ChatStream.TOOL_HISTORY_SKIP.has(base);
  }

  /**
   * 笔录行格式：【我】/【我·工具·名】/ 他人昵称(QQ)[ID:…]
   * @param {object} msg
   * @param {object} [e]
   * @returns {string}
   */
  _formatHistoryMessage(msg, e = null) {
    const msgId = ChatStream.historyEntryId(msg) || '未知';
    const raw = stripLegacyToolUsagePrefix((msg.message || '').replace(/\n/g, ' '));
    const selfId = e?.self_id != null ? String(e.self_id) : null;
    const isBot =
      msg.isBot === true ||
      msg.isTool === true ||
      (selfId != null && msg.user_id != null && String(msg.user_id) === selfId);

    const tags = [
      msg.hasImage ? '[含图片]' : '',
      msg.hasFile ? '[含文件]' : '',
      msg.hasFace ? '[含表情]' : ''
    ]
      .filter(Boolean)
      .join(' ');
    const tagPrefix = tags ? `${tags} ` : '';

    if (isBot && msg.isTool) {
      const label = msg.toolName ? String(msg.toolName) : '工具';
      return `${tagPrefix}【我·工具·${label}】${raw}`;
    }
    if (isBot) {
      return `${tagPrefix}【我】${raw}`;
    }
    const userId = msg.user_id || msg.userId || '未知';
    const nickname = msg.nickname || '未知用户';
    return `${tagPrefix}${nickname}(${userId})[ID:${msgId}]: ${raw}`;
  }

  /**
   * 非对外可视工具摘要写入会话历史，供下一轮延续任务。
   * reply/emotion 等已由 recordAIResponse 覆盖，跳过。
   *
   * @param {object} e
   * @param {string} toolName
   * @param {unknown} result
   * @param {Record<string, unknown>|null} [args]
   */
  recordToolCallResult(e, toolName, result, args = null) {
    if (!ChatStream._shouldRecordToolInHistory(toolName)) return;
    const historyKey = ChatStream.getEventHistoryKey(e);
    if (!historyKey) return;
    try {
      const summary = summarizeToolForHistory(toolName, result, args);
      if (!summary?.trim()) return;
      const msgData = {
        user_id: e.self_id,
        nickname: e.bot?.nickname || e.bot?.info?.nickname || e.bot?.name || 'AgentRuntime',
        message: summary.trim(),
        message_id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        time: Date.now(),
        platform: historyPlatform(e),
        isBot: true,
        isTool: true,
        toolName: String(toolName || '')
      };
      const history = ChatStream.messageHistory.get(historyKey) || [];
      history.push(msgData);
      if (history.length > 50) history.shift();
      ChatStream.messageHistory.set(historyKey, history);
    } catch (err) {
      RuntimeUtil.makeLog('debug', `recordToolCallResult: ${err?.message}`, 'ChatStream');
    }
  }

  async mergeMessageHistory(messages, e) {
    if (!e || messages.length < 2) return messages;

    const userMessage = messages[messages.length - 1];
    const isGlobalTrigger =
      e.isGroup === true &&
      (typeof userMessage.content === 'object' && userMessage.content?.isGlobalTrigger === true);

    const source = this.getHistorySource(e);
    const mergedMessages = [messages[0]];

    if (source) {
      await this.syncHistoryFromAdapter(e);
      const { historyKey } = source;
      const history = ChatStream.messageHistory.get(historyKey) || [];
      const currentMsgId = ChatStream.resolveEventMessageId(e) || '';

      // @/前缀：当前句单独走 [当前消息]，从历史去掉避免重复
      // 全局旁观：只给历史，且必须留下触发句及其 [ID:…]，否则模型只能乱抓旧 ID
      const baseHistory = isGlobalTrigger || !currentMsgId
        ? history
        : history.filter((msg) => ChatStream.historyEntryId(msg) !== currentMsgId);

      const uniqueHistory = [];
      const seenIds = new Set();
      for (let i = baseHistory.length - 1; i >= 0; i--) {
        const msg = baseHistory[i];
        const msgId = ChatStream.historyEntryId(msg);
        if (msgId && !seenIds.has(msgId)) {
          seenIds.add(msgId);
          uniqueHistory.unshift(msg);
        } else if (!msgId) {
          uniqueHistory.unshift(msg);
        }
      }

      const sectionLabel = String(historyKey).startsWith('device_') ? '[近期对话]' : '[群聊记录]';
      const histCfg = getAiWorkflowConfigOptional()?.context?.chatHistory ?? {};
      const defaultLimit = isGlobalTrigger ? 10 : 20;
      const configured = isGlobalTrigger
        ? (typeof histCfg.globalLimit === 'number' ? histCfg.globalLimit : defaultLimit)
        : (typeof histCfg.limit === 'number' ? histCfg.limit : defaultLimit);
      const historyLimit = Math.min(80, Math.max(5, configured));
      const keepFirst = typeof histCfg.keepFirst === 'number' ? Math.max(0, histCfg.keepFirst) : 2;
      let recentMessages = uniqueHistory.slice(-historyLimit);
      // OpenHands keep_first：条数很多时保留最早 N 条锚点 + 尾部
      if (keepFirst > 0 && uniqueHistory.length > historyLimit) {
        const head = uniqueHistory.slice(0, keepFirst);
        const tailBudget = Math.max(1, historyLimit - head.length);
        const tail = uniqueHistory.slice(-tailBudget);
        const seen = new Set(head.map((m) => ChatStream.historyEntryId(m)).filter(Boolean));
        recentMessages = [...head];
        for (const m of tail) {
          const id = ChatStream.historyEntryId(m);
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          recentMessages.push(m);
        }
      }
      const historyFooter = isGlobalTrigger
        ? '\n\n（闲聊旁观：想接哪句接哪句，也可不引用直接说话。勿全文总结、勿逐条点评、勿重复【我】已说过的话。）'
        : '\n\n（说明：以上从上到下由早到晚；【我·工具】= 该步已完成；【我】= 你已回复；**只回应下方 `[当前消息]`**；有 `[引用消息]` 时先认清用户在回谁。普通说话勿带 `[回复:ID]`；要挂引用气泡才写 `[回复:xxx]`。）';

      if (recentMessages.length > 0) {
        mergedMessages.push({
          role: 'user',
          content:
            `${sectionLabel}\n${recentMessages.map((m) => this._formatHistoryMessage(m, e)).join('\n')}` +
            historyFooter
        });
      }
    }

    if (!isGlobalTrigger) {
      const payload = await this._buildCurrentMessagePayload(e, userMessage);
      if (payload) {
        if (payload.images.length > 0 || payload.replyImages.length > 0) {
          mergedMessages.push({
            role: 'user',
            content: {
              text: payload.text,
              images: payload.images,
              replyImages: payload.replyImages
            }
          });
        } else {
          mergedMessages.push({ role: 'user', content: payload.text });
        }
      } else if (typeof userMessage.content === 'string' && userMessage.content.trim()) {
        mergedMessages.push(userMessage);
      }
    }

    return mergedMessages;
  }

  /** 合并 LLM 正文与 reply 工具拟定内容（有拟定则始终以拟定为准，忽略 LLM 收尾摘要） */
  _resolveOutboundText(llmText, turn) {
    if (turn?.replyFlushed) return '';
    const queued = String(turn?.queuedReplyContent ?? '').trim();
    if (queued) return queued;
    return (llmText ?? '').toString().trim();
  }

  async execute(e, question, config) {
    // 保留 process() 写入的 strictToolStreams / toolStreamNames，只刷新 turnState
    const parent = getWorkflowRequestContext() || {};
    return runWithWorkflowRequestContext({
      ...parent,
      e: e ?? parent.e,
      turnState: createUserVisibleTurnState(),
    }, async () => {
      try {
        if (e) this.recordMessage(e);

        const messages = await assembleChatLlmMessages(this, e, question);
        const turn = getWorkflowRequestContext()?.turnState;
        // /recipes 等斜杠已直接回复
        if (turn?.slashShortCircuit) {
          return turn.lastOutboundSummary || '';
        }
        logLlmMessagePreview(this, messages, 'ChatStream');

        const aiResult = await this.callAI(messages, config);

        // reply 已在工具轮内发出：即使 LLM 收尾轮被跳过/返回空，也视为成功
        if (turn?.replyFlushed) {
          return turn.lastOutboundSummary || '';
        }
        if (!aiResult) return null;

        const trimmed = this._resolveOutboundText(aiResult.content, turn);
        if (trimmed) {
          // 无工具拟定的引用时：纯正文发出，不默认挂当前消息引用
          const fallbackReplyId = turn?.queuedReplyMessageId ?? null;
          await this.sendMessages(e, trimmed, { fallbackReplyId });
          const { displayText } = resolveOutgoingMessage(trimmed, { fallbackReplyId });
          const historyText = displayText || trimmed;
          this.recordAIResponse(e, historyText);
          if (turn) turn.lastOutboundSummary = historyText;
        }
        return trimmed || '';
      } catch (error) {
        RuntimeUtil.makeLog('error', `工作流执行失败[${this.name}]: ${error.message}`, 'ChatStream');
        return null;
      }
    });
  }

  /**
   * 向用户发送协议正文。不附加工具名调试前缀（工具对用户不可见）。
   *
   * @param {object} e
   * @param {string} cleanText
   * @param {{ fallbackReplyId?: string|null, replyFallbackOnAllParts?: boolean }} [opts]
   */
  async sendMessages(e, cleanText, { fallbackReplyId = null, replyFallbackOnAllParts = true } = {}) {
    if (!cleanText?.trim() || !e?.reply) return;

    const parts = splitProtocolParts(cleanText);
    if (!parts.length) return;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const useFallback = replyFallbackOnAllParts || i === 0;
      const { replyId, segments } = resolveOutgoingMessage(part, {
        fallbackReplyId: useFallback ? fallbackReplyId : null
      });
      const payload = buildOutboundSegments({ replyId, segments });
      if (!payload.length) continue;

      await e.reply(payload);

      if (i < parts.length - 1) {
        await RuntimeUtil.sleep(randomRange(800, 1500));
      }
    }
  }

  cleanupCache() {
    for (const [historyKey, messages] of ChatStream.messageHistory.entries()) {
      if (!messages || messages.length === 0) {
        ChatStream.messageHistory.delete(historyKey);
        continue;
      }
      if (messages.length > 50) ChatStream.messageHistory.set(historyKey, messages.slice(-50));
    }
  }

  /**
   * 清除指定会话的 chat 历史（对齐 XRK-Yunzai ChatStream.clearConversation）
   * @param {string} scopeId - getEventHistoryKey 或 group/user id
   */
  static async clearConversation(scopeId, { e: _e = null } = {}) {
    const key = String(scopeId);
    const result = { success: true, cleared: { history: false, memory: false } };
    try {
      if (ChatStream.messageHistory.has(key)) {
        ChatStream.messageHistory.delete(key);
        result.cleared.history = true;
      }
      RuntimeUtil.makeLog('debug', `[ChatStream] clearConversation scope=${key}`, 'ChatStream');
    } catch (error) {
      result.success = false;
      RuntimeUtil.makeLog('error', `[ChatStream] clearConversation: ${error.message}`, 'ChatStream');
    }
    return result;
  }

  async cleanup() {
    await super.cleanup();
    
    if (ChatStream.cleanupTimer) {
      clearInterval(ChatStream.cleanupTimer);
      ChatStream.cleanupTimer = null;
    }
  }
}