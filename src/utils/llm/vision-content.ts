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
 * @see .cursor/skills/xrk-v3-api/SKILL.md — 网关多模态仍走 Chat Completions parts
 */

/** 单条 user 消息默认最多附图（引用+当前合计）；可由 llm.visionMaxImages 覆盖 */
export const DEFAULT_VISION_MAX_IMAGES = 10;

export type VisionRole = 'current' | 'reply' | string;

export type VisionRefObject = {
  ref: string;
  role?: VisionRole;
  mime?: string;
  caption?: string;
};

export type VisionRef = string | VisionRefObject;

export type VisionRefInput = VisionRef | {
  url?: string;
  file?: string;
  path?: string;
  src?: string;
  mimeType?: string;
  image_url?: { url?: string };
  [key: string]: unknown;
};

export type VisionRefDefaults = {
  role?: VisionRole;
  mime?: string;
  caption?: string;
};

export type OpenAIVisionPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type AgtVisionContent = {
  text?: string;
  content?: unknown;
  images?: unknown;
  replyImages?: unknown;
  [key: string]: unknown;
};

type MessageSegment = {
  type?: string;
  sub_type?: unknown;
  file?: unknown;
  url?: unknown;
  path?: unknown;
  file_id?: unknown;
  data?: Record<string, unknown> & {
    file?: unknown;
    url?: unknown;
    path?: unknown;
    file_id?: unknown;
    sub_type?: unknown;
  };
  [key: string]: unknown;
};

type VisionEventLike = {
  message?: unknown;
  img?: unknown;
  images?: unknown;
  replyImages?: unknown;
  getReply?: () => Promise<{ message?: unknown } | null | undefined>;
  [key: string]: unknown;
};

type ChatMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

/** 解码日志/CQ/表单里常见的 HTML 实体，避免 `&amp;` 导致 fetch 失败（幂等，可解多层编码） */
export function decodeHtmlEntitiesInUrl(url: unknown): string {
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

export function normalizeVisionRef(
  input: unknown,
  defaults: VisionRefDefaults = {},
): VisionRefObject | null {
  if (input == null) return null;
  if (typeof input === 'string') {
    const ref = decodeHtmlEntitiesInUrl(input);
    if (!ref) return null;
    return {
      ref,
      role: defaults.role,
      mime: defaults.mime,
      caption: defaults.caption,
    };
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown> & {
      image_url?: { url?: string };
    };
    const raw =
      obj.ref ??
      obj.url ??
      obj.file ??
      obj.path ??
      obj.src ??
      obj.image_url?.url;
    const ref = decodeHtmlEntitiesInUrl(raw);
    if (!ref) return null;
    return {
      ref,
      role: (typeof obj.role === 'string' ? obj.role : undefined) || defaults.role,
      mime:
        (typeof obj.mime === 'string' ? obj.mime : undefined) ||
        (typeof obj.mimeType === 'string' ? obj.mimeType : undefined) ||
        defaults.mime,
      caption: (typeof obj.caption === 'string' ? obj.caption : undefined) || defaults.caption,
    };
  }
  return null;
}

export function coerceVisionRefList(
  list: unknown,
  defaults: VisionRefDefaults = {},
): VisionRefObject[] {
  if (!Array.isArray(list)) return [];
  const out: VisionRefObject[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const n = normalizeVisionRef(item, defaults);
    if (!n || seen.has(n.ref)) continue;
    seen.add(n.ref);
    out.push(n);
  }
  return out;
}

/** @param {VisionRef|ReturnType<typeof normalizeVisionRef>} ref */
export function visionRefToLocator(ref: unknown): string {
  const n = normalizeVisionRef(ref);
  return n?.ref || '';
}

export function extractVisionFromSegments(
  segments: unknown,
  opts: {
    skipStickers?: boolean;
    imageTypes?: string[];
    replyTypes?: string[];
  } = {},
): { images: VisionRefObject[]; replyImages: VisionRefObject[] } {
  const images: VisionRefObject[] = [];
  const replyImages: VisionRefObject[] = [];
  const skipStickers = opts.skipStickers !== false;
  const imageTypes = new Set(opts.imageTypes || ['image', 'mface']);
  const replyTypes = new Set(opts.replyTypes || ['reply']);

  const push = (bucket: VisionRefObject[], seg: MessageSegment, role: VisionRole) => {
    const data = seg?.data && typeof seg.data === 'object' ? seg.data : {};
    const candidates = [
      seg?.file,
      seg?.url,
      seg?.path,
      seg?.file_id,
      data.file,
      data.url,
      data.path,
      data.file_id,
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
    const s = seg as MessageSegment;
    const type = String(s.type || '').toLowerCase();

    if (replyTypes.has(type)) {
      inReplyRegion = true;
      continue;
    }

    if (!imageTypes.has(type)) {
      if (type === 'text' || type === 'at') inReplyRegion = false;
      continue;
    }

    if (skipStickers) {
      const subType = s.sub_type ?? s.data?.sub_type;
      if (subType === 1 || subType === '1') continue;
    }

    if (inReplyRegion) {
      push(replyImages, s, 'reply');
      inReplyRegion = false;
    } else {
      push(images, s, 'current');
    }
  }

  return { images, replyImages };
}

export async function extractVisionFromEvent(
  e: VisionEventLike | null | undefined,
  opts: {
    skipStickers?: boolean;
    imageTypes?: string[];
    replyTypes?: string[];
  } = {},
): Promise<{ images: VisionRefObject[]; replyImages: VisionRefObject[] }> {
  const fromSeg = extractVisionFromSegments(e?.message, opts);
  const images = [...fromSeg.images];
  const replyImages = [...fromSeg.replyImages];

  const mergeList = (bucket: VisionRefObject[], list: unknown, role: VisionRole) => {
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
        });
        mergeList(
          replyImages,
          fromReply.images.map((x) => x.ref),
          'reply',
        );
        mergeList(
          replyImages,
          fromReply.replyImages.map((x) => x.ref),
          'reply',
        );
      }
    } catch {
      /* 通道未实现 getReply 时忽略 */
    }
  }

  return { images, replyImages };
}

export function buildAgtUserContent(
  input: {
    text?: unknown;
    images?: unknown;
    replyImages?: unknown;
    extra?: Record<string, unknown>;
  } = {},
): string | Record<string, unknown> {
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
    ...extra,
  };
}

export function mergeUploadedImagesIntoMessages(
  messages: ChatMessage[],
  uploadedLocators: unknown[] | null | undefined,
  opts: { roles?: Array<'current' | 'reply' | string> } = {},
): ChatMessage[] {
  if (!Array.isArray(messages) || !uploadedLocators?.length) return messages;
  const roles = Array.isArray(opts.roles) ? opts.roles : [];

  const current: string[] = [];
  const reply: string[] = [];
  uploadedLocators.forEach((loc, i) => {
    const role = roles[i] === 'reply' ? 'reply' : 'current';
    const n = normalizeVisionRef(loc, { role });
    if (!n) return;
    if (role === 'reply') reply.push(n.ref);
    else current.push(n.ref);
  });

  const imageParts: OpenAIVisionPart[] = [...reply, ...current].map((url) => ({
    type: 'image_url',
    image_url: { url },
  }));

  if (messages.length > 0 && messages[messages.length - 1]?.role === 'user') {
    const last = messages[messages.length - 1]!;
    if (Array.isArray(last.content)) {
      (last.content as OpenAIVisionPart[]).push(...imageParts);
    } else if (typeof last.content === 'string') {
      const text = last.content.trim();
      if (reply.length > 0) {
        last.content = {
          text,
          images: current,
          replyImages: reply,
        };
      } else {
        const imageOnly: OpenAIVisionPart[] = current.map((url) => ({
          type: 'image_url',
          image_url: { url },
        }));
        last.content = text ? [{ type: 'text', text }, ...imageOnly] : imageOnly;
      }
    } else if (last.content && typeof last.content === 'object') {
      const c = last.content as AgtVisionContent;
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
          : imageParts,
    });
  }
  return messages;
}

function isProbablyBareBase64(str: unknown): boolean {
  if (!str || typeof str !== 'string') return false;
  if (str.startsWith('data:')) return true;
  if (str.includes('://')) return false;
  const s = str.trim();
  if (s.length < 64) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(s);
}

function wrapLocatorAsDataUrlIfNeeded(
  locator: unknown,
  { allowBase64, defaultMime }: { allowBase64: boolean; defaultMime: string },
): string {
  let url = decodeHtmlEntitiesInUrl(locator);
  if (!url) return '';
  if (allowBase64 && isProbablyBareBase64(url) && !url.startsWith('data:')) {
    url = `data:${defaultMime};base64,${url}`;
  }
  return url;
}

export function buildOpenAIVisionParts(
  content: AgtVisionContent = {},
  config: { visionImageMimeType?: string; visionMaxImages?: number } = {},
  options: {
    allowBase64?: boolean;
    labelImages?: boolean;
    maxImages?: number;
  } = {},
): OpenAIVisionPart[] {
  const text = content.text != null ? String(content.text) : String(content.content || '');
  const allowBase64 = options.allowBase64 !== false;
  const defaultMime = config.visionImageMimeType || 'image/png';
  const maxImages = Math.max(
    1,
    Number(options.maxImages ?? config.visionMaxImages ?? DEFAULT_VISION_MAX_IMAGES) ||
      DEFAULT_VISION_MAX_IMAGES,
  );
  const replyList = coerceVisionRefList(content.replyImages, { role: 'reply' });
  const currentList = coerceVisionRefList(content.images, { role: 'current' });
  const total = replyList.length + currentList.length;
  const labelImages =
    options.labelImages !== undefined
      ? options.labelImages !== false
      : replyList.length > 0 || total > 1;

  const parts: OpenAIVisionPart[] = [];
  if (text) parts.push({ type: 'text', text });

  let remain = maxImages;
  const appendGroup = (list: VisionRefObject[], roleTag: string) => {
    const slice = list.slice(0, remain);
    const n = slice.length;
    for (let i = 0; i < n; i++) {
      const item = slice[i]!;
      const url = wrapLocatorAsDataUrlIfNeeded(item.ref, { allowBase64, defaultMime });
      if (!url) continue;
      if (labelImages) {
        const caption = item.caption || (n > 1 ? `${roleTag} ${i + 1}/${n}` : roleTag);
        parts.push({ type: 'text', text: `[${caption}]` });
      }
      parts.push({ type: 'image_url', image_url: { url } });
      remain -= 1;
    }
  };

  appendGroup(replyList, '引用附图');
  appendGroup(currentList, '当前附图');

  if (total > maxImages && parts.length) {
    parts.push({
      type: 'text',
      text: `[附图已截断：共 ${total} 张，本次送入 ${maxImages} 张]`,
    });
  }

  return parts;
}

export function countVisionInContent(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === 'string') return 0;
  if (Array.isArray(content)) {
    return content.filter((p) => {
      const part = p as { type?: string };
      return part?.type === 'image_url' || part?.type === 'image' || part?.type === '__image_url__';
    }).length;
  }
  if (typeof content === 'object') {
    const c = content as AgtVisionContent;
    return coerceVisionRefList(c.images).length + coerceVisionRefList(c.replyImages).length;
  }
  return 0;
}
