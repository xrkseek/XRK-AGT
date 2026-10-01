import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_CORE_BASELINE, listSystemCoreJs } from '../helpers/system-core.mjs';

describe('system-Core 模块数量（框架基准）', () => {
  for (const [subdir, expected] of Object.entries(SYSTEM_CORE_BASELINE)) {
    it(`${subdir} = ${expected}`, () => {
      const files = listSystemCoreJs(subdir);
      assert.equal(
        files.length,
        expected,
        `${subdir}: 期望 ${expected}，实际 ${files.length} → [${files.sort().join(', ')}]`
      );
    });
  }
});
