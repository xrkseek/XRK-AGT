/**
 * Runtime 嵌入式 SQLite（Node 内置 `node:sqlite` · DatabaseSync）
 *
 * 与 Redis 同级：由 DatabaseManager 启动期 fail-fast 初始化，挂全局裸名 `sqlite`。
 * 勿使用 npm sqlite3/sqlite；本仓 Node ≥26。
 *
 * @see https://nodejs.org/api/sqlite.html
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import runtimeConfig from './config/config.js'
import paths from '#utils/paths.js'
import { setRuntimeGlobal } from '#utils/runtime-globals.js'

type SqliteDb = InstanceType<typeof DatabaseSync>

let globalDb: SqliteDb | null = null
let globalDbPath: string | null = null

function resolveDb(): SqliteDb | null {
  const fromGlobal = (globalThis as any).sqlite as SqliteDb | undefined
  if (fromGlobal?.isOpen) {
    if (globalDb !== fromGlobal) globalDb = fromGlobal
    return fromGlobal
  }
  return globalDb?.isOpen ? globalDb : null
}

function requireDb(): SqliteDb {
  const db = resolveDb()
  if (!db) throw new Error('[SQLite] 未初始化')
  return db
}

/**
 * 解析 SQLite 文件路径
 * @returns 绝对路径或 `':memory:'`
 */
export function resolveSqliteFilePath(cfg: Record<string, any> = (runtimeConfig as any).sqlite || {}) {
  if (process.env.XRK_SQLITE_MEMORY === '1' || cfg.memory === true) {
    return ':memory:'
  }
  const raw = String(cfg.filePath || 'data/runtime/xrk_agt.db').trim()
  if (!raw || raw === ':memory:') return ':memory:'
  return path.isAbsolute(raw) ? raw : path.join(paths.root, raw)
}

/**
 * 打开 Runtime SQLite（幂等）
 */
export default function sqliteInit() {
  if (globalDb?.isOpen) return globalDb

  const cfg = (runtimeConfig as any).sqlite || {}
  if (cfg.enabled === false) {
    throw new Error('sqlite.enabled=false')
  }

  const filePath = resolveSqliteFilePath(cfg)
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  }

  const busy = Number(cfg.busyTimeoutMs)
  const openOpts: ConstructorParameters<typeof DatabaseSync>[1] = {
    open: true,
    enableForeignKeyConstraints: cfg.foreignKeys !== false
  }
  if (Number.isFinite(busy) && busy >= 0) {
    ;(openOpts as any).timeout = Math.floor(busy)
  }

  const db = new DatabaseSync(filePath, openOpts)
  applyPragmas(db, cfg, filePath)
  db.prepare('SELECT 1 AS ok').get()
  ensureRuntimeSchema(db)

  globalDb = db
  globalDbPath = filePath
  setRuntimeGlobal('sqlite', db)
  return db
}

function applyPragmas(db: SqliteDb, cfg: Record<string, any>, filePath: string) {
  if (cfg.walMode !== false && filePath !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL;')
    } catch {
      /* 部分文件系统不支持 WAL */
    }
  }
  if (cfg.foreignKeys !== false) {
    db.exec('PRAGMA foreign_keys = ON;')
  }
}

/**
 * 创建 Runtime 元表（幂等）
 */
function ensureRuntimeSchema(db: SqliteDb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _xrk_runtime_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _xrk_runtime_kv (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, key)
    );
  `)
  const now = Date.now()
  const upsert = db.prepare(
    `INSERT INTO _xrk_runtime_meta (key, value, updated_at) VALUES (@key, @value, @updated_at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
  upsert.run({ key: 'schema_version', value: '1', updated_at: now })
  upsert.run({ key: 'engine', value: 'node:sqlite', updated_at: now })
}

/**
 * Runtime KV 写入（本地持久标记，非 Redis 替代）
 */
export function sqliteKvSet(namespace: string, key: string, value: string | null | undefined) {
  const db = requireDb()
  const ns = String(namespace || '').trim()
  const k = String(key || '').trim()
  if (!ns || !k) throw new TypeError('sqliteKvSet 需要 namespace 与 key')
  db.prepare(
    `INSERT INTO _xrk_runtime_kv (namespace, key, value, updated_at)
     VALUES (@namespace, @key, @value, @updated_at)
     ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run({
    namespace: ns,
    key: k,
    value: value == null ? null : String(value),
    updated_at: Date.now()
  })
}

export function sqliteKvGet(namespace: string, key: string): string | null {
  const row = requireDb()
    .prepare(`SELECT value FROM _xrk_runtime_kv WHERE namespace = ? AND key = ? LIMIT 1`)
    .get(String(namespace), String(key)) as { value?: string | null } | undefined
  return row?.value ?? null
}

export function sqliteKvDel(namespace: string, key: string) {
  requireDb()
    .prepare(`DELETE FROM _xrk_runtime_kv WHERE namespace = ? AND key = ?`)
    .run(String(namespace), String(key))
}

export function getSqliteClient() {
  return resolveDb()
}

export function getSqlitePath() {
  return globalDbPath
}

export function checkSqlite() {
  const db = resolveDb()
  if (!db) return false
  try {
    return (db.prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined)?.ok === 1
  } catch {
    return false
  }
}

/**
 * 同步事务（BEGIN IMMEDIATE）
 */
export function withSqliteTransaction<T>(fn: (db: SqliteDb) => T): T {
  const db = requireDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn(db)
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
}

export function sqlitePrepare(sql: string) {
  return requireDb().prepare(sql)
}

/** 关闭连接并清空全局挂载 */
export function closeSqlite() {
  const db = resolveDb()
  if (!db) {
    globalDb = null
    globalDbPath = null
    setRuntimeGlobal('sqlite', null)
    return
  }
  try {
    if (db.isOpen) db.close()
  } catch {
    /* ignore */
  }
  globalDb = null
  globalDbPath = null
  setRuntimeGlobal('sqlite', null)
}
