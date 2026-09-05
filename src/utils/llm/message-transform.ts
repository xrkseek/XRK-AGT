/**
 * 消息转换工具：
 * - 统一处理 AGT 形态 `{ text, images, replyImages }`（见 vision-content.js）
 * - 也兼容已是 OpenAI multimodal 数组的 content
 * - 为不同厂商输出：
 *   - openai: OpenAI Chat Completions 多模态 parts（text + image_url），含引用/当前标注与多图上限
 *   - text_only: 纯文本 + 占位描述
 *
 * 真正的图片理解由各家 LLM 多模态能力完成；本层只做结构标准化。
 */

import {
  buildOpenAIVisionParts,
  coerceVisionRefList,
  DEFAULT_VISION_MAX_IMAGES
} from '#utils/llm/vision-content.js';

/**
 * @param {Array} messages
 * @param {Object} config - LLM config（visionImageMimeType / visionMaxImages）
 * @param {Object} options
 * @param {('openai'|'text_only')} [options.mode='text_only']
 * @param {boolean} [options.allowBase64=true]
 * @param {boolean} [options.labelImages]
 * @param {number} [options.maxImages]
 * @returns {Promise<Array>}
 */
export async function transformMessagesWithVision(messages: any, config: any = {}, options: any = {}) {
  if (!Array.isArray(messages)) return messages;

  const mode = options.mode === 'openai' ? 'openai' : 'text_only';
  const allowBase64 = options.allowBase64 !== false;
  const maxImages = Math.max(
    1,
    Number(options.maxImages ?? config.visionMaxImages ?? DEFAULT_VISION_MAX_IMAGES) ||
      DEFAULT_VISION_MAX_IMAGES
  );

  const transformed = [];
  for (const msg of messages) {
    const newMsg = { ...msg };

    if (msg.role === 'user' && msg.content != null && typeof msg.content === 'object') {
      // 已是 OpenAI 风格 parts：openai 模式透传（仍可按上限截断 image_url）
      if (Array.isArray(msg.content) && mode === 'openai') {
        newMsg.content = truncateOpenAIImageParts(msg.content, maxImages);
        transformed.push(newMsg);
        continue;
      }

      if (Array.isArray(msg.content) && mode === 'text_only') {
        newMsg.content = openAIPartsToTextOnly(msg.content);
        transformed.push(newMsg);
        continue;
      }

      const text = msg.content.text || msg.content.content || '';
      const images = msg.content.images || [];
      const replyImages = msg.content.replyImages || [];
      const flags = { ...msg.content };
      delete flags.text;
      delete flags.content;
      delete flags.images;
      delete flags.replyImages;

      if (mode === 'openai') {
        const parts = buildOpenAIVisionParts(
          { text, images, replyImages },
          config,
          { allowBase64, labelImages: options.labelImages, maxImages }
        );
        if (parts.length === 1 && parts[0].type === 'text') {
          newMsg.content = parts[0].text;
        } else if (parts.length > 0) {
          newMsg.content = parts;
        } else {
          newMsg.content = '';
        }
      } else {
        newMsg.content = agtContentToTextOnly(text, images, replyImages, maxImages);
      }

      // 保留非视觉内部标记会污染 API；不回写 flags
      void flags;
    } else if (newMsg.content && typeof newMsg.content === 'object') {
      newMsg.content = newMsg.content.text || newMsg.content.content || '';
    } else if (newMsg.content == null) {
      newMsg.content = '';
    }

    transformed.push(newMsg);
  }

  return transformed;
}

function truncateOpenAIImageParts(parts: any, maxImages: any) {
  let imageCount = 0;
  const out = [];
  let truncated = false;
  for (const p of parts) {
    const isImg =
      p?.type === 'image_url' || p?.type === 'image' || p?.type === '__image_url__';
    if (isImg) {
      if (imageCount >= maxImages) {
        truncated = true;
        continue;
      }
      imageCount += 1;
    }
    out.push(p);
  }
  if (truncated) {
    out.push({
      type: 'text',
      text: `[附图已截断：本次最多送入 ${maxImages} 张]`
    });
  }
  return out;
}

function openAIPartsToTextOnly(parts: any) {
  const texts = [];
  let imgIdx = 0;
  for (const p of parts) {
    if (p?.type === 'text' && p.text) texts.push(String(p.text));
    else if (p?.type === 'image_url' || p?.type === 'image') {
      imgIdx += 1;
      const url = p.image_url?.url || p.url || '';
      texts.push(`[图片${imgIdx}:${String(url).slice(0, 80)}]`);
    }
  }
  return texts.join(' ').trim();
}

function agtContentToTextOnly(text: any, images: any, replyImages: any, maxImages: any) {
  let content = text || '';
  const replyList = coerceVisionRefList(replyImages, { role: 'reply' });
  const currentList = coerceVisionRefList(images, { role: 'current' });
  const all = [...replyList, ...currentList].slice(0, maxImages);
  if (all.length === 0) return content;
  const placeholders = all.map((item, i) => {
    const tag = item.role === 'reply' || replyList.some((r) => r.ref === item.ref)
      ? '引用附图'
      : '当前附图';
    return `[${tag}${all.length > 1 ? ` ${i + 1}/${all.length}` : ''}:${item.ref}]`;
  });
  content = content ? `${content} ${placeholders.join(' ')}` : placeholders.join(' ');
  if (replyList.length + currentList.length > maxImages) {
    content += ` [附图已截断]`;
  }
  return content;
}

/** OpenAI Chat Completions 多模态别名（HTTP v3 / 兼容工厂共用） */
export function transformOpenAIStyleVisionMessages(messages: any, config: any = {}, options: any = {}) {
  return transformMessagesWithVision(messages, config, { mode: 'openai', ...options });
}
