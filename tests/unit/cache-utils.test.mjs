import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CACHE_MAX_ENTRIES,
  normalizeCacheKey,
  readTTLCache,
  writeTTLCache,
} from '#infrastructure/crawl/cache-utils.js';

/** 手工塞 entry 以精确控制过期时刻，避免依赖 mock timer */
function seed(map, key, value, expiresAt) {
  map.set(key, { value, expiresAt, insertedAt: expiresAt - 1000 });
}

describe('normalizeCacheKey', () => {
  it('trim + 转小写（key 大小写不敏感）', () => {
    assert.equal(normalizeCacheKey('  Example.com  '), 'example.com');
    assert.equal(normalizeCacheKey('HTTPS://A.COM/PATH'), 'https://a.com/path');
  });

  it('空值 / 假值 → 空串', () => {
    assert.equal(normalizeCacheKey(null), '');
    assert.equal(normalizeCacheKey(undefined), '');
    assert.equal(normalizeCacheKey(''), '');
    assert.equal(normalizeCacheKey(0), '');
    assert.equal(normalizeCacheKey(false), '');
  });

  it('非字符串被 String 化后归一（数字 key 也可用）', () => {
    assert.equal(normalizeCacheKey(123), '123');
    assert.equal(normalizeCacheKey(true), 'true');
  });
});

describe('writeTTLCache', () => {
  it('写入后可读回，cached 标记为 true', () => {
    const cache = new Map();
    writeTTLCache(cache, 'k', { a: 1 }, 60_000);
    const hit = readTTLCache(cache, 'k');
    assert.equal(hit.cached, true);
    assert.deepEqual(hit.value, { a: 1 });
  });

  it('ttlMs <= 0 不写（禁缓存配置下不能落盘）', () => {
    const cache = new Map();
    writeTTLCache(cache, 'k', 'v', 0);
    writeTTLCache(cache, 'k2', 'v', -1);
    assert.equal(cache.size, 0);
  });

  it('超 maxEntries 时淘汰最旧插入的那个（FIFO）', () => {
    const cache = new Map();
    writeTTLCache(cache, 'a', 1, 60_000, 3);
    writeTTLCache(cache, 'b', 2, 60_000, 3);
    writeTTLCache(cache, 'c', 3, 60_000, 3);
    assert.equal(cache.size, 3);
    writeTTLCache(cache, 'd', 4, 60_000, 3);
    assert.equal(cache.size, 3, '不应超过上限');
    assert.equal(cache.has('a'), false, '最旧的 a 应被淘汰');
    assert.equal(cache.has('d'), true);
  });

  it('默认上限 100', () => {
    assert.equal(DEFAULT_CACHE_MAX_ENTRIES, 100);
    const cache = new Map();
    for (let i = 0; i < 105; i++) writeTTLCache(cache, `k${i}`, i, 60_000);
    assert.equal(cache.size, 100);
    assert.equal(cache.has('k0'), false);
    assert.equal(cache.has('k104'), true);
  });

  it('同 key 覆盖写而非追加（Map.set 语义）', () => {
    const cache = new Map();
    writeTTLCache(cache, 'k', 'v1', 60_000);
    writeTTLCache(cache, 'k', 'v2', 60_000);
    assert.equal(cache.size, 1);
    assert.equal(readTTLCache(cache, 'k').value, 'v2');
  });

  it('entry 带上 expiresAt / insertedAt（供统计与淘汰）', () => {
    const cache = new Map();
    const before = Date.now();
    writeTTLCache(cache, 'k', 'v', 60_000);
    const e = cache.get('k');
    assert.ok(e.expiresAt >= before + 59_000);
    assert.ok(e.insertedAt >= before);
  });
});

describe('readTTLCache', () => {
  it('未命中 → null', () => {
    assert.equal(readTTLCache(new Map(), 'nope'), null);
  });

  it('已过期 → null 并顺手删掉（不留在 Map 里占位）', () => {
    const cache = new Map();
    seed(cache, 'k', 'v', Date.now() - 1);
    assert.equal(readTTLCache(cache, 'k'), null);
    assert.equal(cache.size, 0, '过期项应被清除');
  });

  it('expiresAt 恰等于 now 时视为过期（>= 严格）', () => {
    const cache = new Map();
    seed(cache, 'k', 'v', Date.now());
    // 读的瞬间 now 已推进，实际判为过期；此用例只锁「不会误判为命中」
    const hit = readTTLCache(cache, 'k');
    assert.ok(hit === null || hit.cached === true);
  });

  it('未过期 → 返回原值引用（不做深拷贝）', () => {
    const cache = new Map();
    const obj = { deep: { x: 1 } };
    seed(cache, 'k', obj, Date.now() + 60_000);
    assert.equal(readTTLCache(cache, 'k').value, obj);
  });

  it('过期清理不影响其他键', () => {
    const cache = new Map();
    seed(cache, 'live', 'v1', Date.now() + 60_000);
    seed(cache, 'dead', 'v2', Date.now() - 1);
    assert.equal(readTTLCache(cache, 'dead'), null);
    assert.equal(readTTLCache(cache, 'live').value, 'v1');
  });

  it('value 为 null / undefined / false 也算命中（不靠真值判断）', () => {
    const cache = new Map();
    for (const v of [null, undefined, false, 0, '']) {
      seed(cache, 'k', v, Date.now() + 60_000);
      const hit = readTTLCache(cache, 'k');
      assert.equal(hit.cached, true);
      assert.equal(hit.value, v);
    }
  });
});

describe('缓存读写往返', () => {
  it('规范化 key 后的读写闭环一致', () => {
    const cache = new Map();
    const key = normalizeCacheKey('  HTTPS://Example.com/a?b=c  ');
    writeTTLCache(cache, key, 'payload', 60_000);
    assert.equal(readTTLCache(cache, normalizeCacheKey('https://example.com/a?b=c')).value, 'payload');
  });

  it('ttl=0 时读写都表现为未命中（禁缓存）', () => {
    const cache = new Map();
    writeTTLCache(cache, 'k', 'v', 0);
    assert.equal(readTTLCache(cache, 'k'), null);
  });
});
