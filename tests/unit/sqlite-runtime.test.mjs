/**
 * Runtime SQLite（node:sqlite）单元测
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  default as sqliteInit,
  closeSqlite,
  checkSqlite,
  getSqliteClient,
  getSqlitePath,
  withSqliteTransaction,
  resolveSqliteFilePath,
  sqlitePrepare,
  sqliteKvSet,
  sqliteKvGet,
  sqliteKvDel,
} from '../../dist/src/infrastructure/sqlite.js';

describe('Runtime sqlite (node:sqlite)', () => {
  const prevMem = process.env.XRK_SQLITE_MEMORY;

  before(() => {
    closeSqlite();
    process.env.XRK_SQLITE_MEMORY = '1';
  });

  after(() => {
    closeSqlite();
    if (prevMem == null) delete process.env.XRK_SQLITE_MEMORY;
    else process.env.XRK_SQLITE_MEMORY = prevMem;
  });

  it('resolveSqliteFilePath：XRK_SQLITE_MEMORY → :memory:', () => {
    assert.equal(resolveSqliteFilePath({ filePath: 'data/x.db' }), ':memory:');
  });

  it('init / ping / prepare / 事务', () => {
    const db = sqliteInit();
    assert.equal(db.isOpen, true);
    assert.equal(checkSqlite(), true);
    assert.equal(getSqliteClient(), db);
    assert.equal(getSqlitePath(), ':memory:');

    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    withSqliteTransaction((tx) => {
      tx.prepare('INSERT INTO t (v) VALUES (?)').run('a');
      tx.prepare('INSERT INTO t (v) VALUES (?)').run('b');
    });
    const rows = sqlitePrepare('SELECT v FROM t ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].v, 'a');
  });

  it('事务失败回滚', () => {
    const db = getSqliteClient();
    db.exec('CREATE TABLE IF NOT EXISTS u (id INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM u');
    assert.throws(() => {
      withSqliteTransaction((tx) => {
        tx.prepare('INSERT INTO u DEFAULT VALUES').run();
        throw new Error('boom');
      });
    });
    const n = db.prepare('SELECT COUNT(*) AS c FROM u').get();
    assert.equal(n.c, 0);
  });

  it('Runtime KV 读写删除', () => {
    const db = sqliteInit();
    assert.ok(db.prepare(`SELECT 1 FROM _xrk_runtime_meta WHERE key = 'schema_version'`).get());
    sqliteKvSet('test', 'a', '1');
    assert.equal(sqliteKvGet('test', 'a'), '1');
    sqliteKvDel('test', 'a');
    assert.equal(sqliteKvGet('test', 'a'), null);
  });
});
