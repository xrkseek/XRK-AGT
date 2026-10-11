/**
 */
import { CONTENT_ROLES, INTERACTIVE_ROLES, STRUCTURAL_ROLES } from './snapshot-roles.js'

type SnapshotOptions = {
  maxDepth?: number
  interactive?: boolean
  compact?: boolean
}

type RefData = { role: string; name?: string; nth?: number }

function normalizeRole(raw: unknown) {
  return String(raw || '')
    .trim()
    .toLowerCase()
}

function getIndentLevel(line: string) {
  const match = line.match(/^(\s*)/)
  return match ? Math.floor(match[1].length / 2) : 0
}

function createRoleNameTracker() {
  const counts = new Map<string, number>()
  const refsByKey = new Map<string, string[]>()
  return {
    getKey(role: string, name?: string) {
      return `${role}:${name ?? ''}`
    },
    getNextIndex(role: string, name?: string) {
      const key = `${role}:${name ?? ''}`
      const current = counts.get(key) ?? 0
      counts.set(key, current + 1)
      return current
    },
    trackRef(role: string, name: string | undefined, ref: string) {
      const key = `${role}:${name ?? ''}`
      const list = refsByKey.get(key) ?? []
      list.push(ref)
      refsByKey.set(key, list)
    },
    getDuplicateKeys() {
      const out = new Set<string>()
      for (const [key, refs] of refsByKey) {
        if (refs.length > 1) out.add(key)
      }
      return out
    }
  }
}

function removeNthFromNonDuplicates(refs: Record<string, RefData>, tracker: ReturnType<typeof createRoleNameTracker>) {
  const duplicates = tracker.getDuplicateKeys()
  for (const [ref, data] of Object.entries(refs)) {
    const key = tracker.getKey(data.role, data.name)
    if (!duplicates.has(key)) delete refs[ref]?.nth
  }
}

function compactTree(tree: string) {
  const lines = tree.split('\n')
  const result: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('[ref=')) {
      result.push(line)
      continue
    }
    if (line.includes(':') && !line.trimEnd().endsWith(':')) {
      result.push(line)
      continue
    }
    const currentIndent = getIndentLevel(line)
    let hasRelevantChildren = false
    for (let j = i + 1; j < lines.length; j++) {
      const childIndent = getIndentLevel(lines[j])
      if (childIndent <= currentIndent) break
      if (lines[j]?.includes('[ref=')) {
        hasRelevantChildren = true
        break
      }
    }
    if (hasRelevantChildren) result.push(line)
  }
  return result.join('\n')
}

function matchInteractiveSnapshotLine(line: string, options: SnapshotOptions) {
  const depth = getIndentLevel(line)
  if (options.maxDepth !== undefined && depth > options.maxDepth) return null
  const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/)
  if (!match) return null
  const roleRaw = match[2]
  if (roleRaw.startsWith('/')) return null
  return {
    roleRaw,
    role: normalizeRole(roleRaw),
    name: match[3] as string | undefined,
    suffix: match[4]
  }
}

function processLine(
  line: string,
  refs: Record<string, RefData>,
  options: SnapshotOptions,
  tracker: ReturnType<typeof createRoleNameTracker>,
  nextRef: () => string
) {
  const depth = getIndentLevel(line)
  if (options.maxDepth !== undefined && depth > options.maxDepth) return null

  const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/)
  if (!match) return options.interactive ? null : line

  const [, prefix, roleRaw, name, suffix] = match
  if (roleRaw.startsWith('/')) return options.interactive ? null : line

  const role = normalizeRole(roleRaw)
  const isInteractive = INTERACTIVE_ROLES.has(role)
  const isContent = CONTENT_ROLES.has(role)
  const isStructural = STRUCTURAL_ROLES.has(role)

  if (options.interactive && !isInteractive) return null
  if (options.compact && isStructural && !name) return null

  const shouldHaveRef = isInteractive || (isContent && name)
  if (!shouldHaveRef) return line

  const ref = nextRef()
  const nth = tracker.getNextIndex(role, name)
  tracker.trackRef(role, name, ref)
  refs[ref] = { role, name, nth }

  let enhanced = `${prefix}${roleRaw}`
  if (name) enhanced += ` "${name}"`
  enhanced += ` [ref=${ref}]`
  if (nth > 0) enhanced += ` [nth=${nth}]`
  if (suffix) enhanced += suffix
  return enhanced
}

function buildInteractiveSnapshotLines(params: {
  lines: string[]
  options: SnapshotOptions
  resolveRef: (parsed: {
    role: string
    name?: string
    suffix: string
    roleRaw: string
  }) => { ref?: string; nth?: number } | null
  recordRef: (
    parsed: { role: string; name?: string; suffix: string; roleRaw: string },
    ref: string,
    nth?: number
  ) => void
  includeSuffix: (suffix: string) => boolean
}) {
  const out: string[] = []
  for (const line of params.lines) {
    const parsed = matchInteractiveSnapshotLine(line, params.options)
    if (!parsed || !INTERACTIVE_ROLES.has(parsed.role)) continue
    const resolved = params.resolveRef(parsed)
    if (!resolved?.ref) continue
    params.recordRef(parsed, resolved.ref, resolved.nth)
    let enhanced = `- ${parsed.roleRaw}`
    if (parsed.name) enhanced += ` "${parsed.name}"`
    enhanced += ` [ref=${resolved.ref}]`
    if ((resolved.nth ?? 0) > 0) enhanced += ` [nth=${resolved.nth}]`
    if (params.includeSuffix(parsed.suffix)) enhanced += parsed.suffix
    out.push(enhanced)
  }
  return out
}

export function parseRoleRef(raw: unknown) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  const normalized = trimmed.startsWith('@')
    ? trimmed.slice(1)
    : trimmed.startsWith('ref=')
      ? trimmed.slice(4)
      : trimmed
  if (/^e\d+$/i.test(normalized)) return normalized
  if (/^\d{1,9}$/.test(normalized)) return normalized
  return null
}

export function getRoleSnapshotStats(snapshot: string, refs: Record<string, RefData>) {
  const interactive = Object.values(refs).filter((r) => INTERACTIVE_ROLES.has(r.role)).length
  return {
    lines: snapshot.split('\n').length,
    chars: snapshot.length,
    refs: Object.keys(refs).length,
    interactive
  }
}

export function buildRoleSnapshotFromAriaSnapshot(
  ariaSnapshot: unknown,
  options: SnapshotOptions = {}
) {
  const lines = String(ariaSnapshot || '').split('\n')
  const refs: Record<string, RefData> = {}
  const tracker = createRoleNameTracker()
  let counter = 0
  const nextRef = () => {
    counter += 1
    return `e${counter}`
  }

  if (options.interactive) {
    const result = buildInteractiveSnapshotLines({
      lines,
      options,
      resolveRef: ({ role, name }) => {
        const ref = nextRef()
        const nth = tracker.getNextIndex(role, name)
        tracker.trackRef(role, name, ref)
        return { ref, nth }
      },
      recordRef: ({ role, name }, ref, nth) => {
        refs[ref] = { role, name, nth }
      },
      includeSuffix: (suffix) => suffix.includes('[')
    })
    removeNthFromNonDuplicates(refs, tracker)
    return { snapshot: result.join('\n') || '(no interactive elements)', refs }
  }

  const result: string[] = []
  for (const line of lines) {
    const processed = processLine(line, refs, options, tracker, nextRef)
    if (processed !== null) result.push(processed)
  }
  removeNthFromNonDuplicates(refs, tracker)
  const tree = result.join('\n') || '(empty)'
  return { snapshot: options.compact !== false ? compactTree(tree) : tree, refs }
}

export function buildRoleSnapshotFromAiSnapshot(aiSnapshot: unknown, options: SnapshotOptions = {}) {
  const lines = String(aiSnapshot || '').split('\n')
  const refs: Record<string, RefData> = {}

  const parseAiRef = (suffix: string) => {
    const eMatch = suffix.match(/\[ref=(e\d+)\]/i)
    if (eMatch) return eMatch[1]
    const numMatch = suffix.match(/\[ref=(\d{1,9})\]/)
    return numMatch ? numMatch[1] : null
  }

  if (options.interactive) {
    const out = buildInteractiveSnapshotLines({
      lines,
      options,
      resolveRef: ({ suffix }) => {
        const ref = parseAiRef(suffix)
        return ref ? { ref } : null
      },
      recordRef: ({ role, name }, ref) => {
        refs[ref] = { role, ...(name ? { name } : {}) }
      },
      includeSuffix: () => true
    })
    return { snapshot: out.join('\n') || '(no interactive elements)', refs }
  }

  const out: string[] = []
  for (const line of lines) {
    const parsed = matchInteractiveSnapshotLine(line, options)
    if (!parsed) {
      out.push(line)
      continue
    }
    const ref = parseAiRef(parsed.suffix)
    if (ref) refs[ref] = { role: parsed.role, ...(parsed.name ? { name: parsed.name } : {}) }
    out.push(line)
  }
  return { snapshot: out.join('\n'), refs }
}
