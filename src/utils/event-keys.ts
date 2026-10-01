/**
 * 事件键与插件订阅匹配（多 Tasker 共用，Core 可自定义短名）。
 *
 * 命名：`{tasker}.{post_type}.{detail?}.{sub_type?}`
 * - 跨 Tasker：`message` / `notice.group` …
 * - 定 Tasker：`onebot.message` / `device.*` / `mycore.message` …
 * 定 Tasker 订阅不得命中其它 tasker；事件无 tasker 时定 Tasker 订阅一律不命中。
 */

/** 通用 post_type（非 tasker 短名） */
export const GENERIC_POST_TYPES = Object.freeze(
  new Set(['message', 'notice', 'request', 'meta', 'command']),
);

/** HTTP stdin / 历史 Tasker id → 规范短名 */
const TASKER_ALIASES = Object.freeze({
  api: 'stdin',
  qq: 'opqbot',
} as const);

type TaskerLike = {
  id?: unknown;
  path?: unknown;
  type?: unknown;
};

type EventLike = {
  tasker?: unknown;
  isDevice?: boolean;
  isStdin?: boolean;
  isOneBot?: boolean;
  isOpqbot?: boolean;
  bot?: { tasker?: unknown };
  post_type?: unknown;
  event_type?: unknown;
  message_type?: unknown;
  notice_type?: unknown;
  request_type?: unknown;
  detail_type?: unknown;
  sub_type?: unknown;
};

export function coerceTaskerId(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim()) {
    const id = raw.trim().toLowerCase();
    return (TASKER_ALIASES as Record<string, string>)[id] || id;
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as TaskerLike;
    const id = obj.id ?? obj.path ?? obj.type;
    if (id != null && String(id).trim()) {
      const s = String(id).trim().toLowerCase();
      return (TASKER_ALIASES as Record<string, string>)[s] || s;
    }
  }
  return '';
}

/** 从事件解析规范 tasker 短名（字符串；对象实例取 id/path）。 */
export function resolveTaskerId(e: EventLike | null | undefined): string {
  if (!e) return '';
  const fromField = coerceTaskerId(e.tasker);
  if (fromField) return fromField;

  if (e.isDevice) return 'device';
  if (e.isStdin) return 'stdin';
  if (e.isOneBot) return 'onebot';
  if (e.isOpqbot) return 'opqbot';

  const fromBot = coerceTaskerId(e.bot?.tasker);
  if (fromBot) return fromBot;

  const post = String(e.post_type || '').toLowerCase();
  if (post && !GENERIC_POST_TYPES.has(post)) {
    return (TASKER_ALIASES as Record<string, string>)[post] || post;
  }

  return '';
}

/** 推断缺省 post_type（勿把 message_type/notice_type 值当成 post_type）。 */
export function inferDefaultPostType(e: EventLike | null | undefined): string {
  if (!e) return 'message';
  const post = String(e.post_type || '');
  if (post && GENERIC_POST_TYPES.has(post)) return post;
  if (post && !GENERIC_POST_TYPES.has(post) && e.event_type && GENERIC_POST_TYPES.has(String(e.event_type))) {
    return String(e.event_type);
  }
  if (e.notice_type) return 'notice';
  if (e.request_type) return 'request';
  if (post) return post;
  return 'message';
}

/** 按 post_type 取细分类型。 */
export function resolveDetailType(e: EventLike | null | undefined): string {
  if (!e) return '';
  const post = String(e.post_type || '');
  if (post === 'message') return String(e.message_type || '');
  if (post === 'notice') return String(e.notice_type || '');
  if (post === 'request') return String(e.request_type || '');
  return String(e.detail_type || '');
}

export type EventKeyContext = {
  tasker: string;
  postType: string;
  detailType: string;
  subType: string;
  possibleEvents: string[];
  genericEvents: string[];
};

/** 构建当前事件可匹配的键（具体 → 通用）。 */
export function buildEventKeyContext(e: EventLike | null | undefined): EventKeyContext {
  const tasker = resolveTaskerId(e);
  let postType = String(e?.post_type || '');
  if (postType && !GENERIC_POST_TYPES.has(postType) && e?.event_type && GENERIC_POST_TYPES.has(String(e.event_type))) {
    postType = String(e.event_type);
  }
  const detailType = resolveDetailType(
    postType !== e?.post_type ? { ...e, post_type: postType } : e,
  );
  const subType = String(e?.sub_type || '');
  const possibleEvents: string[] = [];
  const genericEvents: string[] = [];

  if (tasker) {
    if (postType && detailType && subType) possibleEvents.push(`${tasker}.${postType}.${detailType}.${subType}`);
    if (postType && detailType) possibleEvents.push(`${tasker}.${postType}.${detailType}`);
    if (postType) possibleEvents.push(`${tasker}.${postType}`);
    if (detailType) possibleEvents.push(`${tasker}.${detailType}`);
    possibleEvents.push(tasker);
  }

  if (postType && detailType && subType) possibleEvents.push(`${postType}.${detailType}.${subType}`);
  if (postType && detailType) possibleEvents.push(`${postType}.${detailType}`);
  if (detailType) possibleEvents.push(detailType);
  if (postType) {
    possibleEvents.push(postType);
    genericEvents.push(postType);
  }

  return { tasker, postType, detailType, subType, possibleEvents, genericEvents };
}

/**
 * 插件 `event` 是否匹配当前事件。
 */
export function matchPluginEvent(
  pluginEvent: string | null | undefined,
  e: EventLike,
  matchPattern?: (pattern: string, event: string) => boolean,
): boolean {
  if (!pluginEvent) return true;
  const pattern = String(pluginEvent);
  const { tasker, possibleEvents, genericEvents } = buildEventKeyContext(e);
  const head = pattern.split('.')[0] || '';

  if (head && head !== '*' && !GENERIC_POST_TYPES.has(head)) {
    const required = (TASKER_ALIASES as Record<string, string>)[head] || head;
    if (required !== tasker) return false;
  }

  const match = (a: string, b: string) => a === b || (typeof matchPattern === 'function' && matchPattern(a, b));

  for (const actual of possibleEvents) {
    if (match(pattern, actual)) return true;
  }

  if (!pattern.includes('.')) {
    return genericEvents.includes(pattern);
  }

  if (pattern.endsWith('.*') || pattern === head) {
    return possibleEvents.some((ev) => ev === head || ev.startsWith(`${head}.`));
  }

  return false;
}

/** 规范化事件上的 tasker 字段，并提升遗留 post_type/event_type。 */
export function normalizeEventTaskerFields(e: EventLike & Record<string, unknown>): void {
  if (!e) return;
  const tasker = resolveTaskerId(e);
  if (tasker) e.tasker = tasker;

  const post = String(e.post_type || '');
  if (post && !GENERIC_POST_TYPES.has(post) && e.event_type && GENERIC_POST_TYPES.has(String(e.event_type))) {
    if (!e.tasker) e.tasker = (TASKER_ALIASES as Record<string, string>)[post] || post;
    e.post_type = e.event_type;
    delete e.event_type;
  } else if (e.event_type && e.event_type === e.post_type) {
    delete e.event_type;
  }
}
