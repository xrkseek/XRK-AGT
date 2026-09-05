// @ts-nocheck
/**
 * 跨通道视觉内容标准层（QQ / HTTP / Device / Desktop / 任意入口共用）
 *
 * ## 内部形态（AGT user content）
 * ```js
 * { text: string, images?: VisionRef[], replyImages?: VisionRef[] }
 * ```
 * - `images`：本条消息附图
 * - `replyImages`：被引用/回复消息中的附图
 *
 * ## VisionRef
 * - 简写：`string`（http / data URL / 本地路径 / QQ file 哈希 / base64://）
 * - 对象：`{ ref, role?, mime?, caption? }`
 *
 * ## 出站线缆（厂商无关中间态）
 * OpenAI Chat Completions 多模态 parts：
 * `[{ type:'text', text }, { type:'image_url', image_url:{ url } }, ...]`
 * 各 LLM 工厂再转为 Anthropic / Gemini / Ollama 等协议。
 *
 * 设计原则：入口归一到 AGT 形态 → transform 出 OpenAI parts → 工厂按厂商编码。
 * 不另起 VisionFactory，不绑死 QQ。
 */

/** 单条 user 消息默认最多附图（引用+当前合计）；可由 llm.visionMaxImages 覆盖 */
export const DEFAULT_VISION_MAX_IMAGES = 10;

/** 解码日志/CQ/表单里常见的 HTML 实体，避免 `&amp;` 导致 fetch 失败（幂等，可解多层编码） */
export function decodeHtmlEntitiesInUrl(url) {
  let s = String(url ?? '').trim();
  if (!s) return '';
  for (let i = 0; i < 5; i++) {
    const next = s
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'");
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * @typedef {string | {
 *   ref: string,
 *   role?: 'current' | 'reply',
 *   mime?: string,
 *   caption?: string
 * }} VisionRef
 */

/**
 * @param {unknown} input
 * @param {{ role?: 'current'|'reply', mime?: string, caption?: string }} [defaults]
 * @returns {{ ref: string, role?: string, mime?: string, caption?: string }|null}
 */
export function normalizeVisionRef(input, defaults = {}) {
  if (input == null) return null;
  if (typeof input === 'string') {
    const ref = decodeHtmlEntitiesInUrl(input);
    if (!ref) return null;
    return {
      ref,
      role: defaults.role,
      mime: defaults.mime,
      caption: defaults.caption
    };
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    const raw =
      input.ref ??
      input.url ??
      input.file ??
      input.path ??
      input.src ??
      input.image_url?.url;
    const ref = decodeHtmlEntitiesInUrl(raw);
    if (!ref) return null;
    return {
      ref,
      role: input.role || defaults.role,
      mime: input.mime || input.mimeType || defaults.mime,
      caption: input.caption || defaults.caption
    };
  }
  return null;
}

/**
 * @param {unknown} list
 * @param {{ role?: 'current'|'reply' }} [defaults]
 * @returns {Array<{ ref: string, role?: string, mime?: string, caption?: string }>}
 */
export function coerceVisionRefList(list, defaults = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const n = normalizeVisionRef(item, defaults);
    if (!n || seen.has(n.ref)) continue;
    seen.add(n.ref);
    out.push(n);
  }
  return out;
}

/** @param {VisionRef|ReturnType<typeof normalizeVisionRef>} ref */
export function visionRefToLocator(ref) {
  const n = normalizeVisionRef(ref);
  return n?.ref || '';
}

/**
 * 从通用消息段提取附图（不绑死 QQ；兼容 OneBot / device / 自定义 type）
 * @param {unknown[]} segments
 * @param {{
 *   skipStickers?: boolean,
 *   imageTypes?: string[],
 *   replyTypes?: string[]
 * }} [opts]
 * @returns {{ images: ReturnType<typeof normalizeVisionRef>[], replyImages: ReturnType<typeof normalizeVisionRef>[] }}
 */
export function extractVisionFromSegments(segments, opts = {}) {
  const images = [];
  const replyImages = [];
  const skipStickers = opts.skipStickers !== false;
  const imageTypes = new Set(opts.imageTypes || ['image', 'mface']);
  const replyTypes = new Set(opts.replyTypes || ['reply']);

  const push = (bucket, seg, role) => {
    const data = seg?.data && typeof seg.data === 'object' ? seg.data : {};
    const candidates = [
      seg?.file,
      seg?.url,
      seg?.path,
      seg?.file_id,
      data.file,
      data.url,
      data.path,
      data.file_id
    ];
    for (const c of candidates) {
      const n = normalizeVisionRef(c, { role });
      if (!n) continue;
      if (bucket.some((x) => x.ref === n.ref)) return;
      bucket.push(n);
      return;
    }
  };

  if (!Array.isArray(segments)) return { images, replyImages };

  let inReplyRegion = false;
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const type = String(seg.type || '').toLowerCase();

    if (replyTypes.has(type)) {
      inReplyRegion = true;
      continue;
    }

    if (!imageTypes.has(type)) {
      if (type === 'text' || type === 'at') inReplyRegion = false;
      continue;
    }

    if (skipStickers) {
      const subType = seg.sub_type ?? seg.data?.sub_type;
      if (subType === 1 || subType === '1') continue;
    }

    if (inReplyRegion) {
      push(replyImages, seg, 'reply');
      inReplyRegion = false;
    } else {
      push(images, seg, 'current');
    }
  }

  return { images, replyImages };
}

/**
 * 从事件对象提取附图（通道无关：有 message 段 / img 列表 / getReply 即可）
 * @param {object|null|undefined} e
 * @param {object} [opts]
 */
export async function extractVisionFromEvent(e, opts = {}) {
  const fromSeg = extractVisionFromSegments(e?.message, opts);
  const images = [...fromSeg.images];
  const replyImages = [...fromSeg.replyImages];

  const mergeList = (bucket, list, role) => {
    for (const item of coerceVisionRefList(list, { role })) {
      if (!bucket.some((x) => x.ref === item.ref)) bucket.push(item);
    }
  };

  if (Array.isArray(e?.img)) mergeList(images, e.img, 'current');
  if (Array.isArray(e?.images)) mergeList(images, e.images, 'current');
  if (Array.isArray(e?.replyImages)) mergeList(replyImages, e.replyImages, 'reply');

  if (typeof e?.getReply === 'function') {
    try {
      const reply = await e.getReply();
      if (reply && Array.isArray(reply.message)) {
        const fromReply = extractVisionFromSegments(reply.message, {
          ...opts,
          // 被引用消息内的图一律算 replyImages
        });
        // 引用目标消息里的图：无论是否带 reply 段，都并入 replyImages
        mergeList(replyImages, fromReply.images.map((x) => x.ref), 'reply');
        mergeList(replyImages, fromReply.replyImages.map((x) => x.ref), 'reply');
      }
    } catch {
      /* 通道未实现 getReply 时忽略 */
    }
  }

  return { images, replyImages };
}

/**
 * 组装 AGT user content：无图时退化为纯字符串（省 token / 兼容旧路径）
 * @param {{
 *   text?: string,
 *   images?: unknown,
 *   replyImages?: unknown,
 *   extra?: Record<string, unknown>
 * }} input
 * @returns {string | { text: string, images: string[], replyImages: string[], [k: string]: unknown }}
 */
export function buildAgtUserContent(input = {}) {
  const text = input.text != null ? String(input.text) : '';
  const images = coerceVisionRefList(input.images, { role: 'current' });
  const replyImages = coerceVisionRefList(input.replyImages, { role: 'reply' });
  const extra = input.extra && typeof input.extra === 'object' ? input.extra : {};

  if (images.length === 0 && replyImages.length === 0) {
    if (Object.keys(extra).length === 0) return text;
    return { text, ...extra };
  }

  return {
    text,
    images: images.map((x) => x.ref),
    replyImages: replyImages.map((x) => x.ref),
    ...extra
  };
}

/**
 * 将上传图合并进 messages 最后一条 user（HTTP / 任意入口）
 * @param {object[]} messages
 * @param {string[]} uploadedLocators
 * @param {{ roles?: Array<'current'|'reply'|string> }} [opts]
 */
export function mergeUploadedImagesIntoMessages(messages, uploadedLocators, opts = {}) {
  if (!Array.isArray(messages) || !uploadedLocators?.length) return messages;
  const roles = Array.isArray(opts.roles) ? opts.roles : [];

  const current = [];
  const reply = [];
  uploadedLocators.forEach((loc, i) => {
    const role = roles[i] === 'reply' ? 'reply' : 'current';
    const n = normalizeVisionRef(loc, { role });
    if (!n) return;
    if (role === 'reply') reply.push(n.ref);
    else current.push(n.ref);
  });

  const imageParts = [...reply, ...current].map((url) => ({
    type: 'image_url',
    image_url: { url }
  }));

  if (messages.length > 0 && messages[messages.length - 1]?.role === 'user') {
    const last = messages[messages.length - 1];
    if (Array.isArray(last.content)) {
      last.content.push(...imageParts);
    } else if (typeof last.content === 'string') {
      const text = last.content.trim();
      // 有 reply 角色时走 AGT 对象形态，便于 transform 标注「引用附图」
      if (reply.length > 0) {
        last.content = {
          text,
          images: current,
          replyImages: reply
        };
      } else {
        const imageOnly = current.map((url) => ({
          type: 'image_url',
          image_url: { url }
        }));
        last.content = text ? [{ type: 'text', text }, ...imageOnly] : imageOnly;
      }
    } else if (last.content && typeof last.content === 'object') {
      const c = last.content;
      c.text = (c.text || c.content || '').toString();
      c.images = [...coerceVisionRefList(c.images).map((x) => x.ref), ...current];
      c.replyImages = [...coerceVisionRefList(c.replyImages).map((x) => x.ref), ...reply];
      last.content = c;
    } else {
      last.content = imageParts;
    }
  } else {
    messages.push({
      role: 'user',
      content:
        reply.length > 0
          ? { text: '', images: current, replyImages: reply }
          : imageParts
    });
  }
  return messages;
}

function isProbablyBareBase64(str) {
  if (!str || typeof str !== 'string') return false;
  if (str.startsWith('data:')) return true;
  if (str.includes('://')) return false;
  const s = str.trim();
  if (s.length < 64) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(s);
}

function wrapLocatorAsDataUrlIfNeeded(locator, { allowBase64, defaultMime }) {
  let url = decodeHtmlEntitiesInUrl(locator);
  if (!url) return '';
  if (allowBase64 && isProbablyBareBase64(url) && !url.startsWith('data:')) {
    url = `data:${defaultMime};base64,${url}`;
  }
  return url;
}

/**
 * AGT {text,images,replyImages} → OpenAI multimodal parts（标准化、可标注、可截断）
 * @param {{ text?: string, images?: unknown, replyImages?: unknown }} content
 * @param {{ visionImageMimeType?: string, visionMaxImages?: number }} [config]
 * @param {{
 *   allowBase64?: boolean,
 *   labelImages?: boolean,
 *   maxImages?: number
 * }} [options]
 * @returns {Array<{type:string, text?:string, image_url?:{url:string}}>}
 */
export function buildOpenAIVisionParts(content = {}, config = {}, options = {}) {
  const text = content.text != null ? String(content.text) : String(content.content || '');
  const allowBase64 = options.allowBase64 !== false;
  const defaultMime = config.visionImageMimeType || 'image/png';
  const maxImages = Math.max(
    1,
    Number(options.maxImages ?? config.visionMaxImages ?? DEFAULT_VISION_MAX_IMAGES) || DEFAULT_VISION_MAX_IMAGES
  );
  // 有引用图、或多于 1 张图时默认加短标注，便于模型区分
  const replyList = coerceVisionRefList(content.replyImages, { role: 'reply' });
  const currentList = coerceVisionRefList(content.images, { role: 'current' });
  const total = replyList.length + currentList.length;
  const labelImages =
    options.labelImages !== undefined
      ? options.labelImages !== false
      : replyList.length > 0 || total > 1;

  const parts = [];
  if (text) parts.push({ type: 'text', text });

  let remain = maxImages;
  const appendGroup = (list, roleTag) => {
    const slice = list.slice(0, remain);
    const n = slice.length;
    for (let i = 0; i < n; i++) {
      const item = slice[i];
      const url = wrapLocatorAsDataUrlIfNeeded(item.ref, { allowBase64, defaultMime });
      if (!url) continue;
      if (labelImages) {
        const caption =
          item.caption ||
          (n > 1 ? `${roleTag} ${i + 1}/${n}` : roleTag);
        parts.push({ type: 'text', text: `[${caption}]` });
      }
      parts.push({ type: 'image_url', image_url: { url } });
      remain -= 1;
    }
  };

  // 先引用图、后当前图（与历史约定一致；标注消除歧义）
  appendGroup(replyList, '引用附图');
  appendGroup(currentList, '当前附图');

  if (total > maxImages && parts.length) {
    parts.push({
      type: 'text',
      text: `[附图已截断：共 ${total} 张，本次送入 ${maxImages} 张]`
    });
  }

  return parts;
}

/**
 * 统计 user 消息中的附图数量（三种形态）
 * @param {unknown} content
 */
export function countVisionInContent(content) {
  if (content == null) return 0;
  if (typeof content === 'string') return 0;
  if (Array.isArray(content)) {
    return content.filter(
      (p) => p?.type === 'image_url' || p?.type === 'image' || p?.type === '__image_url__'
    ).length;
  }
  if (typeof content === 'object') {
    return (
      coerceVisionRefList(content.images).length +
      coerceVisionRefList(content.replyImages).length
    );
  }
  return 0;
}
