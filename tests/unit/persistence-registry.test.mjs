/**
 * 多模持久化薄 SPI：注册 / 探活 / 就绪面 soft 语义
 */
import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSISTENCE_POLICY,
  registerPersistenceProvider,
  clearPersistenceProviders,
  probePersistenceProviders,
  listPersistenceProviders,
} from '../../dist/src/infrastructure/database/persistence-registry.js';
import { buildReadinessSnapshot } from '#utils/observability.js';
import sqliteInit, { closeSqlite } from '../../dist/src/infrastructure/sqlite.js';

describe('persistence-registry', () => {
  beforeEach(() => clearPersistenceProviders());
  afterEach(() => clearPersistenceProviders());

  it('PERSISTENCE_POLICY 固定跨库最终一致、无跨引擎 UoW', () => {
    assert.equal(PERSISTENCE_POLICY.crossStore, 'eventual-consistency-only');
    assert.equal(PERSISTENCE_POLICY.unitOfWork, 'none-across-engines');
    assert.equal(PERSISTENCE_POLICY.redis, 'runtime-required');
    assert.equal(PERSISTENCE_POLICY.sqlite, 'runtime-embedded');
  });

  it('未注册时 status=idle', async () => {
    const p = await probePersistenceProviders();
    assert.equal(p.status, 'idle');
    assert.deepEqual(p.stores, {});
  });

  it('部分可用 → degraded；全挂 → unavailable', async () => {
    registerPersistenceProvider({
      id: 'mongodb',
      kind: 'document',
      core: 'mongodb-Core',
      ping: async () => true,
    });
    registerPersistenceProvider({
      id: 'qdrant',
      kind: 'vector',
      core: 'vector-Core',
      ping: async () => false,
    });
    const mixed = await probePersistenceProviders();
    assert.equal(mixed.status, 'degraded');
    assert.equal(mixed.stores.mongodb.status, 'operational');
    assert.equal(mixed.stores.qdrant.status, 'unavailable');

    clearPersistenceProviders();
    registerPersistenceProvider({
      id: 'postgres',
      kind: 'relational',
      ping: async () => false,
    });
    const down = await probePersistenceProviders();
    assert.equal(down.status, 'unavailable');
  });

  it('缺 id/ping 拒绝注册', () => {
    assert.throws(() => registerPersistenceProvider({ id: 'x' }), TypeError);
    assert.equal(listPersistenceProviders().length, 0);
  });
});

describe('readiness + persistence', () => {
  const prevMem = process.env.XRK_SQLITE_MEMORY;

  before(() => {
    process.env.XRK_SQLITE_MEMORY = '1';
    closeSqlite();
    sqliteInit();
  });

  after(() => {
    closeSqlite();
    if (prevMem == null) delete process.env.XRK_SQLITE_MEMORY;
    else process.env.XRK_SQLITE_MEMORY = prevMem;
  });

  beforeEach(() => clearPersistenceProviders());
  afterEach(() => clearPersistenceProviders());

  it('可选存储全挂不把 overall 打成 unhealthy（Redis+SQLite 仍健康时）', async () => {
    registerPersistenceProvider({
      id: 'mongodb',
      kind: 'document',
      ping: async () => false,
    });
    const snap = await buildReadinessSnapshot({
      includeLoaders: false,
      includeMcp: false,
      includeSubservers: false,
      agentRuntime: null,
    });
    assert.ok(snap.services.persistence);
    assert.equal(snap.services.persistence.status, 'unavailable');
    assert.ok(snap.services.persistence.policy?.unitOfWork);
    assert.equal(snap.services.sqlite, 'operational');
    if (snap.services.redis === 'operational') {
      assert.notEqual(snap.status, 'unhealthy');
    }
  });

  it('部分可选存储可用时 soft degraded（Redis/SQLite 仍健康）', async () => {
    registerPersistenceProvider({
      id: 'mongodb',
      kind: 'document',
      ping: async () => true,
    });
    registerPersistenceProvider({
      id: 'postgres',
      kind: 'relational',
      ping: async () => false,
    });
    const snap = await buildReadinessSnapshot({
      includeLoaders: false,
      includeMcp: false,
      includeSubservers: false,
      agentRuntime: null,
    });
    assert.equal(snap.services.persistence.status, 'degraded');
    assert.equal(snap.services.sqlite, 'operational');
    if (snap.services.redis === 'operational') {
      assert.equal(snap.status, 'degraded');
      assert.notEqual(snap.status, 'unhealthy');
    }
  });
});
