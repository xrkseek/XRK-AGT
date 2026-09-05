/**
 * Runtime 数据库门面：Redis（热）+ SQLite（嵌入式落盘）
 *
 * Mongo / Postgres / Qdrant 等可选存储不在此初始化，见 persistence-registry。
 */
import redisInit, { closeRedis, getRedisClient } from '../redis.js';
import sqliteInit, {
  closeSqlite,
  getSqliteClient,
  checkSqlite,
  withSqliteTransaction,
  getSqlitePath,
  sqlitePrepare,
  sqliteKvSet,
  sqliteKvGet,
  sqliteKvDel,
} from '../sqlite.js';

export {
  PERSISTENCE_POLICY,
  registerPersistenceProvider,
  unregisterPersistenceProvider,
  clearPersistenceProviders,
  listPersistenceProviders,
  probePersistenceProviders,
} from './persistence-registry.js';

export {
  withSqliteTransaction,
  getSqlitePath,
  checkSqlite,
  sqlitePrepare,
  sqliteKvSet,
  sqliteKvGet,
  sqliteKvDel,
};

class DatabaseManager {
  redis: any = null;
  sqlite: any = null;
  initialized = false;

  /**
   * 启动期初始化（fail-fast）
   */
  async init(): Promise<{ redis: boolean; sqlite: boolean }> {
    if (this.initialized) {
      return { redis: !!this.redis, sqlite: !!this.sqlite };
    }
    this.redis = (await redisInit()) ?? getRedisClient();
    this.sqlite = sqliteInit();
    this.initialized = true;
    return { redis: !!this.redis, sqlite: !!this.sqlite };
  }

  getRedis(): any {
    return this.redis;
  }

  getSqlite(): any {
    return this.sqlite;
  }

  async checkRedis(): Promise<boolean> {
    const redis = this.redis;
    if (!redis?.isOpen) return false;
    try {
      await redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  checkSqlite(): boolean {
    return checkSqlite();
  }

  async close(): Promise<void> {
    await closeRedis().catch(() => {});
    closeSqlite();
    this.redis = null;
    this.sqlite = null;
    this.initialized = false;
  }
}

let instance: DatabaseManager | null = null;

export function getDatabaseManager(): DatabaseManager {
  if (!instance) instance = new DatabaseManager();
  return instance;
}

export async function initDatabases(): Promise<DatabaseManager> {
  const manager = getDatabaseManager();
  await manager.init();
  return manager;
}

export async function closeDatabases(): Promise<void> {
  await getDatabaseManager().close();
}

export function getRedis(): any {
  return getDatabaseManager().getRedis();
}

export function getSqlite(): any {
  return getDatabaseManager().getSqlite() ?? getSqliteClient();
}

export default getDatabaseManager;
