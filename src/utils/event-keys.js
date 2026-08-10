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
)

/** HTTP stdin / 历史 Tasker id → 规范短名 */
const TASKER_ALIASES = Object.freeze({
  api: 'stdin',
  qq: 'opqbot',
})

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function coerceTaskerId(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    const id = raw.trim().toLowerCase()
    return TASKER_ALIASES[id] || id
  }
  if (raw && typeof raw === 'object') {
    const id = raw.id ?? raw.path ?? raw.type
    if (id != null && String(id).trim()) {
      const s = String(id).trim().toLowerCase()
      return TASKER_ALIASES[s] || s
    }
  }
  return ''
}

/**
 * 从事件解析规范 tasker 短名（字符串；对象实例取 id/path）。
 * @param {object} e
 * @returns {string}
 */
export function resolveTaskerId(e) {
  if (!e) return ''
  const fromField = coerceTaskerId(e.tasker)
  if (fromField) return fromField

  if (e.isDevice) return 'device'
  if (e.isStdin) return 'stdin'
  if (e.isOneBot) return 'onebot'
  if (e.isOpqbot) return 'opqbot'

  // bot.tasker 实例（历史挂载：id/path → 短名）
  const fromBot = coerceTaskerId(e.bot?.tasker)
  if (fromBot) return fromBot

  // 遗留：post_type 曾承载 tasker 短名（如 post_type=device + event_type=message）
  const post = String(e.post_type || '').toLowerCase()
  if (post && !GENERIC_POST_TYPES.has(post)) return TASKER_ALIASES[post] || post

  return ''
}

/**
 * 推断缺省 post_type（勿把 message_type/notice_type 值当成 post_type）。
 * @param {object} e
 * @returns {string}
 */
export function inferDefaultPostType(e) {
  if (!e) return 'message'
  const post = String(e.post_type || '')
  if (post && GENERIC_POST_TYPES.has(post)) return post
  if (post && !GENERIC_POST_TYPES.has(post) && e.event_type && GENERIC_POST_TYPES.has(e.event_type)) {
    return e.event_type
  }
  if (e.notice_type) return 'notice'
  if (e.request_type) return 'request'
  if (post) return post
  return 'message'
}

/**
 * 按 post_type 取细分类型。
 * @param {object} e
 * @returns {string}
 */
export function resolveDetailType(e) {
  if (!e) return ''
  const post = String(e.post_type || '')
  if (post === 'message') return e.message_type || ''
  if (post === 'notice') return e.notice_type || ''
  if (post === 'request') return e.request_type || ''
  return e.detail_type || ''
}

/**
 * 构建当前事件可匹配的键（具体 → 通用）。
 * @param {object} e
 */
export function buildEventKeyContext(e) {
  const tasker = resolveTaskerId(e)
  let postType = String(e?.post_type || '')
  if (postType && !GENERIC_POST_TYPES.has(postType) && e?.event_type && GENERIC_POST_TYPES.has(e.event_type)) {
    postType = e.event_type
  }
  const detailType = resolveDetailType(
    postType !== e?.post_type ? { ...e, post_type: postType } : e,
  )
  const subType = e?.sub_type || ''
  const possibleEvents = []
  const genericEvents = []

  if (tasker) {
    if (postType && detailType && subType) possibleEvents.push(`${tasker}.${postType}.${detailType}.${subType}`)
    if (postType && detailType) possibleEvents.push(`${tasker}.${postType}.${detailType}`)
    if (postType) possibleEvents.push(`${tasker}.${postType}`)
    if (detailType) possibleEvents.push(`${tasker}.${detailType}`)
    possibleEvents.push(tasker)
  }

  if (postType && detailType && subType) possibleEvents.push(`${postType}.${detailType}.${subType}`)
  if (postType && detailType) possibleEvents.push(`${postType}.${detailType}`)
  if (detailType) possibleEvents.push(detailType)
  if (postType) {
    possibleEvents.push(postType)
    genericEvents.push(postType)
  }

  return { tasker, postType, detailType, subType, possibleEvents, genericEvents }
}

/**
 * 插件 `event` 是否匹配当前事件。
 * @param {string} pluginEvent
 * @param {object} e
 * @param {(pattern: string, event: string) => boolean} [matchPattern]
 */
export function matchPluginEvent(pluginEvent, e, matchPattern) {
  if (!pluginEvent) return true
  const pattern = String(pluginEvent)
  const { tasker, possibleEvents, genericEvents } = buildEventKeyContext(e)
  const head = pattern.split('.')[0] || ''

  // 定 Tasker 订阅：无 tasker 或短名不一致 → 不命中（防串台 / 裸 message 误触 onebot.*）
  if (head && head !== '*' && !GENERIC_POST_TYPES.has(head)) {
    const required = TASKER_ALIASES[head] || head
    if (required !== tasker) return false
  }

  const match = (a, b) => a === b || (typeof matchPattern === 'function' && matchPattern(a, b))

  for (const actual of possibleEvents) {
    if (match(pattern, actual)) return true
  }

  if (!pattern.includes('.')) {
    return genericEvents.includes(pattern)
  }

  if (pattern.endsWith('.*') || pattern === head) {
    return possibleEvents.some((ev) => ev === head || ev.startsWith(`${head}.`))
  }

  return false
}

/**
 * 规范化事件上的 tasker 字段，并提升遗留 post_type/event_type。
 * @param {object} e
 */
export function normalizeEventTaskerFields(e) {
  if (!e) return
  const tasker = resolveTaskerId(e)
  if (tasker) e.tasker = tasker

  const post = String(e.post_type || '')
  if (post && !GENERIC_POST_TYPES.has(post) && e.event_type && GENERIC_POST_TYPES.has(e.event_type)) {
    if (!e.tasker) e.tasker = TASKER_ALIASES[post] || post
    e.post_type = e.event_type
    delete e.event_type
  } else if (e.event_type && e.event_type === e.post_type) {
    delete e.event_type
  }
}
