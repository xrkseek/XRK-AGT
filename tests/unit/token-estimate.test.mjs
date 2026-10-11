/**
 * 属性 / 算法正确性：token 估算单调性与边界
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokensRough,
  estimateTokensMixed,
} from '#utils/token-estimate.js';

describe('token-estimate 属性', () => {
  it('rough：空串为 0；长度单调不减', () => {
    assert.equal(estimateTokensRough(''), 0);
    assert.equal(estimateTokensRough(null), 0);
    let prev = 0;
    for (let n = 1; n <= 64; n++) {
      const cur = estimateTokensRough('a'.repeat(n));
      assert.ok(cur >= prev, `n=${n} 应单调`);
      prev = cur;
    }
  });

  it('rough：约 4 字符 / token', () => {
    assert.equal(estimateTokensRough('abcd'), 1);
    assert.equal(estimateTokensRough('abcdefgh'), 2);
  });

  it('mixed：空/非字符串为 0；中文密度高于纯英文同长', () => {
    assert.equal(estimateTokensMixed(''), 0);
    assert.equal(estimateTokensMixed(null), 0);
    const zh = estimateTokensMixed('你好世界测试文本');
    const en = estimateTokensMixed('helloworldtestxx');
    assert.ok(zh > en);
  });

  it('mixed：拼接不减少估算（弱单调）', () => {
    const a = '上下文压缩';
    const b = ' with english words';
    assert.ok(estimateTokensMixed(a + b) >= estimateTokensMixed(a));
  });

  it('mixed：URL/长 hex 按密度单独计量且 >0', () => {
    const url = 'see https://example.com/a/b/c?x=1&y=2 for docs';
    const hex = 'id ' + 'a'.repeat(32);
    assert.ok(estimateTokensMixed(url) >= 4);
    assert.ok(estimateTokensMixed(hex) >= 4);
  });
});
