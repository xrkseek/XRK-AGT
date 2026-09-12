import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('www xrk config/flat 导出契约', () => {
  const src = readFileSync(
    path.resolve('core/system-Core/www/xrk/src/config/flat.js'),
    'utf8',
  );

  for (const name of [
    'resolveFieldControl',
    'normalizeOptions',
    'formatTagsText',
    'parseTagsText',
    'canonicalizeArrayObjectValue',
    'canonicalizeObjectByFields',
    'buildDirtyFlat',
    'buildDefaultsFromFields',
    'applyFlatJsonObject',
  ]) {
    it(`导出 ${name}`, () => {
      assert.match(src, new RegExp(`export function ${name}\\(`));
    });
  }

  it('resolveFieldControl 识别 Tags', () => {
    assert.match(src, /c === '(?:multiselect|tags)' \|\| c === '(?:multiselect|tags)'/);
  });
});
