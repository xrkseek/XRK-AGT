/**
 * Levenshtein 两行 DP：正确性（对照朴素实现）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TextSimilarity } from '#utils/neural-algorithms.js';

/** 朴素全矩阵对照 */
function naive(a, b) {
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

describe('levenshteinDistance', () => {
  it('经典用例', () => {
    assert.equal(TextSimilarity.levenshteinDistance('kitten', 'sitting'), 3);
    assert.equal(TextSimilarity.levenshteinDistance('', 'abc'), 3);
    assert.equal(TextSimilarity.levenshteinDistance('abc', 'abc'), 0);
  });

  it('与朴素实现一致（含长短交换）', () => {
    const pairs = [
      ['', ''],
      ['a', ''],
      ['short', 'longerstring'],
      ['你好世界', '你好世间'],
      ['abc', 'yabd'],
      ['aaaaaaaa', 'bbbbbbbb']
    ];
    for (const [x, y] of pairs) {
      assert.equal(TextSimilarity.levenshteinDistance(x, y), naive(x, y));
      assert.equal(TextSimilarity.levenshteinDistance(y, x), naive(y, x));
    }
  });
});
