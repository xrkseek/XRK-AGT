/**
 * Process-scoped harness SessionStore + conversation key → session id.
 * Uses SDK createPersistentSessionStore under data/harness-sessions.
 */
import path from 'node:path'
import fs from 'node:fs'
import paths from '#utils/paths.js'

const MAX_TRACKED_KEYS = 64
const SESSIONS_DIR = path.join(paths.data, 'harness-sessions')

type SessionStore = {
  create: (id?: string) => { id: string }
  has?: (id: string) => boolean
  append?: (sessionId: string, event: unknown) => unknown
  close?: () => void
}

type HarnessNs = {
  createMemorySessionStore: () => SessionStore
  createPersistentSessionStore: (dir: string, opts?: { maxResidentSessions?: number }) => SessionStore
}

let store: SessionStore | null = null
/** conversationKey → sessionId (LRU order in keyOrder) */
const keyToId = new Map<string, string>()
const keyOrder: string[] = []

function preferMemoryStore() {
  return process.env.XRK_HARNESS_SESSION_MEMORY === '1' || process.env.NODE_TEST_CONTEXT != null
}

export function sanitizeHarnessSessionId(raw: unknown): string {
  const s = String(raw || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)
  return s || `agt_${Date.now().toString(36)}`
}

function touchKey(key: string) {
  const i = keyOrder.indexOf(key)
  if (i >= 0) keyOrder.splice(i, 1)
  keyOrder.push(key)
  while (keyOrder.length > MAX_TRACKED_KEYS) {
    const old = keyOrder.shift()
    if (old) keyToId.delete(old)
  }
}

export function getHarnessSessionStore(harness: HarnessNs): SessionStore {
  if (store) return store
  if (preferMemoryStore()) {
    store = harness.createMemorySessionStore()
    return store
  }
  const dir = process.env.XRK_HARNESS_SESSIONS_DIR
    ? path.resolve(process.env.XRK_HARNESS_SESSIONS_DIR)
    : SESSIONS_DIR
  fs.mkdirSync(dir, { recursive: true })
  try {
    store = harness.createPersistentSessionStore(dir, {
      maxResidentSessions: 16
    })
  } catch {
    // Fallback: single in-memory store (no cross-process durability)
    store = harness.createMemorySessionStore()
  }
  return store
}

/** True if conversationKey already maps to a live harness session (no create). */
export function hasHarnessSession(harness: HarnessNs, conversationKey: unknown): boolean {
  if (!conversationKey || !String(conversationKey).trim()) return false
  const s = getHarnessSessionStore(harness)
  const id = sanitizeHarnessSessionId(`agt_${conversationKey}`)
  return typeof s.has === 'function' && s.has(id)
}

export function acquireHarnessSession(
  harness: HarnessNs,
  conversationKey: string | null | undefined
): { store: SessionStore; sessionId: string; reused: boolean } {
  const s = getHarnessSessionStore(harness)
  if (!conversationKey || !String(conversationKey).trim()) {
    const session = s.create()
    return { store: s, sessionId: session.id, reused: false }
  }

  const id = sanitizeHarnessSessionId(`agt_${conversationKey}`)
  if (typeof s.has === 'function' && s.has(id)) {
    touchKey(String(conversationKey))
    keyToId.set(String(conversationKey), id)
    return { store: s, sessionId: id, reused: true }
  }

  try {
    s.create(id)
  } catch {
    if (typeof s.has === 'function' && s.has(id)) {
      touchKey(String(conversationKey))
      keyToId.set(String(conversationKey), id)
      return { store: s, sessionId: id, reused: true }
    }
    const session = s.create()
    return { store: s, sessionId: session.id, reused: false }
  }

  touchKey(String(conversationKey))
  keyToId.set(String(conversationKey), id)
  return { store: s, sessionId: id, reused: false }
}

/** Patch store.append to observe live session events (Face-style; multi-listener safe). */
const listenerBags = new WeakMap<
  SessionStore,
  {
    original: (sessionId: string, event: unknown) => unknown
    listeners: Set<(out: unknown, sessionId: string) => void>
  }
>()

export function attachHarnessSessionListener(
  storeArg: SessionStore,
  onEvent: (out: unknown, sessionId: string) => void
) {
  if (typeof onEvent !== 'function' || !storeArg || typeof storeArg.append !== 'function') {
    return () => {}
  }
  let bag = listenerBags.get(storeArg)
  if (!bag) {
    const original = storeArg.append.bind(storeArg)
    const listeners = new Set<(out: unknown, sessionId: string) => void>()
    storeArg.append = (sessionId: string, event: unknown) => {
      const out = original(sessionId, event)
      for (const fn of listeners) {
        try {
          fn(out, sessionId)
        } catch {
          /* ignore */
        }
      }
      return out
    }
    bag = { original, listeners }
    listenerBags.set(storeArg, bag)
  }
  bag.listeners.add(onEvent)
  return () => {
    bag!.listeners.delete(onEvent)
    if (bag!.listeners.size === 0) {
      storeArg.append = bag!.original
      listenerBags.delete(storeArg)
    }
  }
}

/** Test helper */
export function resetHarnessSessionRegistryForTests() {
  if (store && typeof store.close === 'function') {
    try {
      store.close()
    } catch {
      /* ignore */
    }
  }
  store = null
  keyToId.clear()
  keyOrder.length = 0
}
