/**
 * Process-scoped harness SessionStore + conversation key → session id.
 * Uses SDK createPersistentSessionStore under data/harness-sessions.
 */
import path from 'node:path'
import fs from 'node:fs'
import type { SessionEvent, SessionStore as SdkSessionStore } from '@xrkseek/harness'
import paths from '#utils/paths.js'

const MAX_TRACKED_KEYS = 64
const SESSIONS_DIR = path.join(paths.data, 'harness-sessions')

/** SDK store + optional close for persistent / test cleanup */
export type HarnessSessionStore = SdkSessionStore & {
  close?: () => void
}

export type HarnessSessionNs = {
  createMemorySessionStore: () => HarnessSessionStore
  createPersistentSessionStore: (
    dir: string,
    opts?: { maxResidentSessions?: number }
  ) => HarnessSessionStore
}

let store: HarnessSessionStore | null = null
/** conversationKey → sessionId (LRU order in keyOrder) */
const keyToId = new Map<string, string>()
const keyOrder: string[] = []

function preferMemoryStore() {
  // Explicit sessions dir → always persistent (isolated test dirs / overrides).
  if (process.env.XRK_HARNESS_SESSIONS_DIR) return false;
  if (process.env.XRK_HARNESS_SESSION_MEMORY === '0') return false;
  return process.env.XRK_HARNESS_SESSION_MEMORY === '1' || process.env.NODE_TEST_CONTEXT != null;
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

export function getHarnessSessionStore(harness: HarnessSessionNs): HarnessSessionStore {
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
export function hasHarnessSession(harness: HarnessSessionNs, conversationKey: unknown): boolean {
  if (!conversationKey || !String(conversationKey).trim()) return false
  const s = getHarnessSessionStore(harness)
  const id = sanitizeHarnessSessionId(`agt_${conversationKey}`)
  return typeof s.has === 'function' && s.has(id)
}

export function acquireHarnessSession(
  harness: HarnessSessionNs,
  conversationKey: string | null | undefined
): { store: HarnessSessionStore; sessionId: string; reused: boolean } {
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
export type HarnessSessionEventListener = (out: SessionEvent | unknown, sessionId: string) => void

const listenerBags = new WeakMap<
  HarnessSessionStore,
  {
    original: (sessionId: string, event: SessionEvent) => SessionEvent
    listeners: Set<HarnessSessionEventListener>
  }
>()

export function attachHarnessSessionListener(
  storeArg: HarnessSessionStore,
  onEvent: HarnessSessionEventListener | null | undefined
) {
  if (typeof onEvent !== 'function' || !storeArg || typeof storeArg.append !== 'function') {
    return () => {}
  }
  let bag = listenerBags.get(storeArg)
  if (!bag) {
    const original = storeArg.append.bind(storeArg)
    const listeners = new Set<HarnessSessionEventListener>()
    storeArg.append = (sessionId: string, event: SessionEvent) => {
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
