import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyModuleImportError,
  extractMissingPackageName,
  isMissingPackageError
} from '#utils/module-import-error.js';
import * as database from '../../dist/src/infrastructure/database/index.js';

describe('module-import-error 分类', () => {
  it('识别 Cannot find package', () => {
    const err = new Error("Cannot find package 'mongodb' imported from C:\\x\\init.js");
    err.stack = `Error: Cannot find package 'mongodb' imported from C:\\x\\init.js\n    at ...`;
    const c = classifyModuleImportError(err);
    assert.equal(c.kind, 'missing_package');
    assert.equal(c.packageName, 'mongodb');
    assert.equal(extractMissingPackageName(err), 'mongodb');
    assert.equal(isMissingPackageError(err), true);
  });

  it('识别 scoped 包名', () => {
    const err = new Error("Cannot find package '@qdrant/js-client-rest' imported from ./client.js");
    assert.equal(extractMissingPackageName(err), '@qdrant/js-client-rest');
  });

  it('识别缺失 named export（非缺依赖）', () => {
    const err = new Error(
      "The requested module '#infrastructure/database/index.js' does not provide an export named 'getMongoDb'"
    );
    const c = classifyModuleImportError(err);
    assert.equal(c.kind, 'missing_export');
    assert.equal(c.exportName, 'getMongoDb');
    assert.equal(c.packageName, '#infrastructure/database/index.js');
    assert.equal(isMissingPackageError(err), false);
    assert.equal(extractMissingPackageName(err), null);
  });

  it('首个引号误匹配回退：导出错误不得当成依赖名', () => {
    const err = new Error(
      "The requested module '#infrastructure/database/index.js' does not provide an export named 'getMongoDb'"
    );
    err.stack = err.message;
    assert.notEqual(extractMissingPackageName(err), '#infrastructure/database/index.js');
  });

  it('本地绝对路径缺失不是 npm 包', () => {
    const err = new Error(
      "Cannot find module 'C:\\Users\\x\\src\\infrastructure\\bot\\tasker.js' imported from C:\\Users\\x\\core\\Feishu.js"
    );
    const c = classifyModuleImportError(err);
    assert.equal(c.kind, 'missing_file');
    assert.equal(isMissingPackageError(err), false);
    assert.equal(extractMissingPackageName(err), null);
  });

  it('相对路径缺失不是 npm 包', () => {
    const err = new Error("Cannot find module './missing.js' imported from ./x.js");
    assert.equal(classifyModuleImportError(err).kind, 'missing_file');
    assert.equal(isMissingPackageError(err), false);
  });
});

describe('Runtime database 导出契约', () => {
  it('暴露 Redis + SQLite，不导出 getMongoDb', () => {
    assert.equal(typeof database.getRedis, 'function');
    assert.equal(typeof database.getSqlite, 'function');
    assert.equal(typeof database.getDatabaseManager, 'function');
    assert.equal(typeof database.initDatabases, 'function');
    assert.equal(typeof database.withSqliteTransaction, 'function');
    assert.equal('getMongoDb' in database, false);
    assert.equal(database.getMongoDb, undefined);
  });
});
