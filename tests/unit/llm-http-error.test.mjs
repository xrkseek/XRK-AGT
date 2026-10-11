import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLlmHttpError,
  parseStatusFromMessage,
  parseRetryAfterMs,
} from '#utils/llm/llm-http-error.js';

describe('parseStatusFromMessage', () => {
  it('从消息文本中抓 4xx/5xx 状态码', () => {
    assert.equal(parseStatusFromMessage('HTTP 429 rate limited'), 429);
    assert.equal(parseStatusFromMessage('upstream returned 503'), 503);
  });

  it('忽略 2xx/3xx（重试层只关心错误码）', () => {
    assert.equal(parseStatusFromMessage('HTTP 200 ok'), 0);
    assert.equal(parseStatusFromMessage('HTTP 302 redirect'), 0);
  });

  it('无匹配 / 空输入返回 0，不抛错', () => {
    assert.equal(parseStatusFromMessage('connection reset'), 0);
    assert.equal(parseStatusFromMessage(''), 0);
    assert.equal(parseStatusFromMessage(null), 0);
    assert.equal(parseStatusFromMessage(undefined), 0);
  });

  it('只取首个匹配：409 之后又出现 500 时不覆盖', () => {
    assert.equal(parseStatusFromMessage('409 conflict then 500'), 409);
  });

  it('不把 4 位数里的三位片段当状态码（\\b 边界）', () => {
    assert.equal(parseStatusFromMessage('code 4291'), 0);
    assert.equal(parseStatusFromMessage('v5000 build'), 0);
  });
});

describe('parseRetryAfterMs', () => {
  it('秒数形式：Retry-After: 30 → 30000ms', () => {
    assert.equal(parseRetryAfterMs({ get: () => '30' }), 30_000);
  });

  it('Headers 实例形态（提供 get 方法）', () => {
    const headers = new Headers({ 'Retry-After': '5' });
    assert.equal(parseRetryAfterMs(headers), 5_000);
  });

  it('普通对象形态：大小写两种键都能取到', () => {
    assert.equal(parseRetryAfterMs({ 'retry-after': '2' }), 2_000);
    assert.equal(parseRetryAfterMs({ 'Retry-After': '2' }), 2_000);
  });

  it('小数秒向下取整为整毫秒', () => {
    assert.equal(parseRetryAfterMs({ get: () => '1.9' }), 1_900);
  });

  it('超过 120s 上限则钳到 120000ms（防止上游写 absurd 值）', () => {
    assert.equal(parseRetryAfterMs({ get: () => '99999' }), 120_000);
    assert.equal(parseRetryAfterMs({ get: () => '3600' }), 120_000);
  });

  it('HTTP-date 形式：换算成距今毫秒', () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const ms = parseRetryAfterMs({ get: () => future });
    assert.ok(ms !== null && ms > 40_000 && ms <= 45_000, `got ${ms}`);
  });

  it('过去的 HTTP-date 钳到 0（不返回负数）', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    assert.equal(parseRetryAfterMs({ get: () => past }), 0);
  });

  it('超 120s 的 HTTP-date 也钳到上限', () => {
    const far = new Date(Date.now() + 600_000).toUTCString();
    assert.equal(parseRetryAfterMs({ get: () => far }), 120_000);
  });

  it('空值 / 缺头 / 空串 / 非法值 → null（调用方据此不重试）', () => {
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs(undefined), null);
    assert.equal(parseRetryAfterMs({}), null);
    assert.equal(parseRetryAfterMs({ get: () => null }), null);
    assert.equal(parseRetryAfterMs({ get: () => '' }), null);
    assert.equal(parseRetryAfterMs({ get: () => 'soon' }), null);
  });

  it('负数秒数：宽松降级为 0（立即重试），非 null', () => {
    // 现状记录：'-5' 走 Number 分支被 >=0 拦下 → 落进 date 分支，
    // 而 V8 的 Date.parse('-5') 会宽松解析成 2001 年 → clamp 到 0。
    // 语义即「不等重试」。若要严格拒绝畸形值，需在数字分支显式判负并返回 null。
    assert.equal(parseRetryAfterMs({ get: () => '-5' }), 0);
  });
});

describe('createLlmHttpError', () => {
  it('status 同时镜像到 statusCode（消费方两种写法都兼容）', () => {
    const err = createLlmHttpError('boom', { status: 429 });
    assert.equal(err.status, 429);
    assert.equal(err.statusCode, 429);
  });

  it('statusCode 缺省时从消息文本回捞', () => {
    const err = createLlmHttpError('HTTP 503 upstream down');
    assert.equal(err.status, 503);
    assert.equal(err.statusCode, 503);
  });

  it('显式 extra 优先于消息内解析', () => {
    const err = createLlmHttpError('HTTP 500', { status: 429 });
    assert.equal(err.status, 429);
  });

  it('status=0 视为未提供，回落到消息解析', () => {
    const err = createLlmHttpError('HTTP 401 unauthorized', { status: 0 });
    assert.equal(err.status, 401);
  });

  it('无任何状态信息时不写 status 字段（保持 undefined 语义）', () => {
    const err = createLlmHttpError('network down');
    assert.equal(err.status, undefined);
    assert.equal(err.statusCode, undefined);
  });

  it('是真正的 Error 实例（继承链完整，可 instanceof / stack）', () => {
    const err = createLlmHttpError('boom', { status: 500 });
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'boom');
    assert.ok(typeof err.stack === 'string' && err.stack.length > 0);
  });

  it('透传 code', () => {
    assert.equal(createLlmHttpError('x', { code: 'rate_limit_exceeded' }).code, 'rate_limit_exceeded');
    assert.equal(createLlmHttpError('x').code, undefined);
  });

  it('retryAfterMs：显式值优先于 headers 解析', () => {
    const err = createLlmHttpError('x', {
      status: 429,
      retryAfterMs: 777,
      headers: { get: () => '60' },
    });
    assert.equal(err.retryAfterMs, 777);
  });

  it('无显式值时从 headers 解析 retryAfterMs', () => {
    const err = createLlmHttpError('x', { status: 429, headers: { get: () => '12' } });
    assert.equal(err.retryAfterMs, 12_000);
  });

  it('headers 解析不出值时不写 retryAfterMs（而非写 0）', () => {
    const err = createLlmHttpError('x', { status: 503, headers: { get: () => 'nope' } });
    assert.equal(err.retryAfterMs, undefined);
  });
});
