/**
 * Process-scoped harness SessionStore + conversation key → session id.
 * Uses SDK createPersistentSessionStore under data/harness-sessions.
 */
import path from 'node:path';
import fs from 'node:fs';
import paths from '#utils/paths.js';

const MAX_TRACKED_KEYS = 64;
const SESSIONS_DIR = path.join(paths.data, 'harness-sessions');

/** @type {import('@xrkseek/harness').SessionStore | null} */
let store = null;
/** conversationKey → sessionId (LRU order in keyOrder) */
const keyToId = new Map();
const keyOrder = [];

function preferMemoryStore() {
  return process.env.XRK_HARNESS_SESSION_MEMORY === '1'
    || process.env.NODE_TEST_CONTEXT != null;
}

export function sanitizeHarnessSessionId(raw) {
  const s = String(raw || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return s || `agt_${Date.now().toString(36)}`;
}

function touchKey(key) {
  const i = keyOrder.indexOf(key);
  if (i >= 0) keyOrder.splice(i, 1);
  keyOrder.push(key);
  while (keyOrder.length > MAX_TRACKED_KEYS) {
    const old = keyOrder.shift();
    if (old) keyToId.delete(old);
  }
}

/**
 * @param {object} harness SDK namespace
 * @returns {object} SessionStore
 */
export function getHarnessSessionStore(harness) {
  if (store) return store;
  if (preferMemoryStore()) {
    store = harness.createMemorySessionStore();
    return store;
  }
  const dir = process.env.XRK_HARNESS_SESSIONS_DIR
    ? path.resolve(process.env.XRK_HARNESS_SESSIONS_DIR)
    : SESSIONS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  try {
    store = harness.createPersistentSessionStore(dir, {
      maxResidentSessions: 16,
    });
  } catch (err) {
    // Fallback: single in-memory store (no cross-process durability)
    store = harness.createMemorySessionStore();
  }
  return store;
}

/**
 * @param {object} harness
 * @param {string|null|undefined} conversationKey
 * @returns {{ store: object, sessionId: string, reused: boolean }}
 */
export function acquireHarnessSession(harness, conversationKey) {
  const s = getHarnessSessionStore(harness);
  if (!conversationKey || !String(conversationKey).trim()) {
    const session = s.create();
    return { store: s, sessionId: session.id, reused: false };
  }

  const id = sanitizeHarnessSessionId(`agt_${conversationKey}`);
  if (typeof s.has === 'function' && s.has(id)) {
    touchKey(String(conversationKey));
    keyToId.set(String(conversationKey), id);
    return { store: s, sessionId: id, reused: true };
  }

  try {
    s.create(id);
  } catch (err) {
    if (typeof s.has === 'function' && s.has(id)) {
      touchKey(String(conversationKey));
      keyToId.set(String(conversationKey), id);
      return { store: s, sessionId: id, reused: true };
    }
    const session = s.create();
    return { store: s, sessionId: session.id, reused: false };
  }

  touchKey(String(conversationKey));
  keyToId.set(String(conversationKey), id);
  return { store: s, sessionId: id, reused: false };
}

/** Patch store.append to observe live session events (Face-style; multi-listener safe). */
const listenerBags = new WeakMap();

export function attachHarnessSessionListener(store, onEvent) {
  if (typeof onEvent !== 'function' || !store || typeof store.append !== 'function') {
    return () => {};
  }
  let bag = listenerBags.get(store);
  if (!bag) {
    const original = store.append.bind(store);
    const listeners = new Set();
    store.append = (sessionId, event) => {
      const out = original(sessionId, event);
      for (const fn of listeners) {
        try { fn(out, sessionId); } catch { /* ignore */ }
      }
      return out;
    };
    bag = { original, listeners };
    listenerBags.set(store, bag);
  }
  bag.listeners.add(onEvent);
  return () => {
    bag.listeners.delete(onEvent);
    if (bag.listeners.size === 0) {
      store.append = bag.original;
      listenerBags.delete(store);
    }
  };
}

/** Test helper */
export function resetHarnessSessionRegistryForTests() {
  if (store && typeof store.close === 'function') {
    try { store.close(); } catch { /* ignore */ }
  }
  store = null;
  keyToId.clear();
  keyOrder.length = 0;
}

export default {
  sanitizeHarnessSessionId,
  getHarnessSessionStore,
  acquireHarnessSession,
  attachHarnessSessionListener,
  resetHarnessSessionRegistryForTests,
};
