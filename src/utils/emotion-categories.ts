/**
 * 表情包分类（resources/aiimages/{分类}/）与群消息表情回应 ID 的统一配置。
 * 往 resources/aiimages 下对应文件夹塞图片即可；reactionIds 用于 emojiReaction（NapCat set_msg_emoji_like）。
 *
 * reactionIds 对照 QQ 系统表情 type=1，见 https://bot.q.qq.com/wiki/develop/nodesdk/model/emoji.html
 *
 * 分类与 XRK-Yunzai lib/utils/emotion-categories.js 对齐。
 */

export type EmotionCategory = {
  reactionIds?: string[];
};

export const EMOTION_CATEGORIES: Record<string, EmotionCategory> = {
  开心: { reactionIds: ['4', '14', '21', '28', '76', '79', '99', '182', '201', '290'] },
  大笑: { reactionIds: ['12', '28', '101', '182', '281'] },
  喜欢: { reactionIds: ['42', '63', '85', '116', '122', '319'] },
  爱心: { reactionIds: ['66', '122', '319'] },
  惊讶: { reactionIds: ['26', '32', '97', '180', '268', '289'] },
  伤心: { reactionIds: ['5', '9', '106', '111', '173', '174'] },
  生气: { reactionIds: ['23', '39', '86', '179', '265', '326'] },
  害怕: { reactionIds: ['26', '27', '41', '96'] },
  无语: { reactionIds: ['270', '272', '284', '287'] },
  尴尬: { reactionIds: ['10', '100'] },
  得意: { reactionIds: ['4', '16', '183'] },
  委屈: { reactionIds: ['106', '111', '176'] },
  疑惑: { reactionIds: ['32', '268', '314'] },
  害羞: { reactionIds: ['21', '175'] },
  鄙视: { reactionIds: ['23', '265'] },
  吃瓜: { reactionIds: ['271', '269'] },
  可爱: { reactionIds: ['21', '175', '307'] },
  谢谢: { reactionIds: ['297', '118'] },
  抱歉: { reactionIds: ['174', '123'] },
  庆祝: { reactionIds: ['320', '144', '306'] },
  加油: { reactionIds: ['30', '246', '315'] },
  摸鱼: { reactionIds: ['285', '29'] },
  晚安: { reactionIds: ['8', '25', '104'] },
  睡: { reactionIds: ['8', '25', '104'] },
};

export const EMOTION_TYPES = Object.keys(EMOTION_CATEGORIES);

/** 有 QQ 表情回应 ID 的子集（emojiReaction 工具） */
export const EMOJI_REACTION_TYPES = EMOTION_TYPES.filter(
  (name) => (EMOTION_CATEGORIES[name].reactionIds?.length ?? 0) > 0,
);

/** emojiReaction / emotion 英文别名 → 中文分类 */
export const EMOJI_REACTION_ALIASES: Record<string, string> = {
  happy: '开心',
  laugh: '大笑',
  like: '喜欢',
  love: '爱心',
  wow: '惊讶',
  sad: '伤心',
  angry: '生气',
  fear: '害怕',
  speechless: '无语',
  awkward: '尴尬',
  proud: '得意',
  aggrieved: '委屈',
  confused: '疑惑',
  shy: '害羞',
  disdain: '鄙视',
  melon: '吃瓜',
  cute: '可爱',
  thanks: '谢谢',
  sorry: '抱歉',
  celebrate: '庆祝',
  cheer: '加油',
  slack: '摸鱼',
  goodnight: '晚安',
  sleep: '睡',
};

export const EMOTION_IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|bmp)$/i;

export function normalizeEmotionType(
  raw: unknown,
  aliases: Record<string, string> = EMOJI_REACTION_ALIASES,
): string {
  const t = String(raw ?? '').trim();
  return aliases[t] || t;
}

export function getEmojiReactionIds(emotionType: string): string[] | null {
  const ids = EMOTION_CATEGORIES[emotionType]?.reactionIds;
  return ids?.length ? ids : null;
}

export function formatEmotionTypeList(types: string[] = EMOTION_TYPES): string {
  return types.join('、');
}

/** 兼容旧代码：分类名 → reactionIds */
export const QQ_EMOJI_REACTION_IDS = Object.fromEntries(
  EMOTION_TYPES.map((name) => [name, EMOTION_CATEGORIES[name].reactionIds || []]),
);
