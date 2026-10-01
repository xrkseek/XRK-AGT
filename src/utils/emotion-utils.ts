/**
 * 表情解析与映射工具
 * - 设备 / stream / xiaozhi：SUPPORTED_EMOTIONS · PARSEABLE_EMOTIONS · parseEmotion
 * - QQ 聊天表情包 / 贴表情：见 emotion-categories.js（与 Yunzai resources/aiimages 分类对齐）
 */

export {
  EMOTION_CATEGORIES,
  EMOTION_TYPES,
  EMOJI_REACTION_TYPES,
  EMOJI_REACTION_ALIASES,
  EMOTION_IMAGE_EXTS,
  QQ_EMOJI_REACTION_IDS,
  normalizeEmotionType,
  getEmojiReactionIds,
  formatEmotionTypeList,
} from '#utils/emotion-categories.js';

/**
 * 小智固件侧使用的表情 / 图标名称
 */
export const SUPPORTED_EMOTIONS = [
  // 通用情绪
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'laugh',

  // 状态 / 图标类（与固件 Alert / 资产加载一致）
  'sleepy',
  'microchip_ai',
  'triangle_exclamation',
  'circle_xmark',
  'cloud_arrow_down',
  'cloud_slash',
  'download',
] as const;

/** 中文关键词 -> 设备表情代码（仅设备侧子集） */
const EMOTION_KEYWORDS: Record<string, string> = {
  开心: 'happy',
  高兴: 'happy',
  伤心: 'sad',
  难过: 'sad',
  生气: 'angry',
  愤怒: 'angry',
  惊讶: 'surprised',
  吃惊: 'surprised',
  大笑: 'laugh',
  哈哈: 'laugh',
  害怕: 'sad',
  晚安: 'sleepy',
  睡: 'sleepy',
};

/**
 * 系统提示与 stream/device 解析支持的中文表情标记（设备子集）。
 * QQ 聊天发表情包请用 EMOTION_TYPES（emotion-categories）。
 */
export const PARSEABLE_EMOTIONS = ['开心', '惊讶', '伤心', '大笑', '害怕', '生气'] as const;

/**
 * 从文本中解析 [开心]、[惊讶] 等情绪标记（设备 stream）
 */
export function parseEmotion(text: string | null | undefined): {
  emotion: string | null;
  cleanText: string;
} {
  const group = PARSEABLE_EMOTIONS.join('|');
  const regex = new RegExp(`^\\s*\\[(${group})[\\]\\}]\\s*`);
  const match = regex.exec(text || '');
  if (!match) {
    return { emotion: null, cleanText: (text || '').trim() };
  }
  const emotion = EMOTION_KEYWORDS[match[1]!] || null;
  const cleanText = (text || '').replace(regex, '').trim();
  return { emotion, cleanText };
}

/**
 * 从消息文本中查找第一个匹配的表情关键词，返回对应的表情代码
 */
export function findEmotionFromKeywords(text: unknown): string | null {
  if (!text || typeof text !== 'string') return null;
  for (const [keyword, emotion] of Object.entries(EMOTION_KEYWORDS)) {
    if (text.includes(keyword)) return emotion;
  }
  return null;
}

/**
 * 统一将中文/英文表情规范为设备支持的代码，不支持的返回 null
 */
export function normalizeEmotionToDevice(emotion: unknown): string | null {
  if (!emotion) return null;
  const code = EMOTION_KEYWORDS[String(emotion)] || String(emotion);
  return (SUPPORTED_EMOTIONS as readonly string[]).includes(code) ? code : null;
}
