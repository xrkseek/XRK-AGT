/**
 * 路径模糊 / 属性：InputValidator 拒穿越族
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { InputValidator } from '#utils/input-validator.js';
import { RuntimeError } from '#utils/error-handler.js';

const dataRoot = path.join(process.cwd(), 'data');

const TRAVERSAL = [
  '../etc/passwd',
  '..\\..\\windows\\system32',
  'server_bots/../../etc/passwd',
  'server_bots/../../../etc/passwd',
  './../secret',
  'foo/./../../bar',
  '%2e%2e/%2e%2e/etc/passwd',
  '..%2f..%2fetc/passwd',
];

describe('InputValidator 路径模糊', () => {
  for (const sample of TRAVERSAL) {
    it(`拒绝穿越样例: ${JSON.stringify(sample)}`, () => {
      assert.throws(() => InputValidator.validatePath(sample, dataRoot), RuntimeError);
    });
  }

  it('属性：normalize 后仍含 .. 的路径均拒绝', () => {
    const seeds = ['a', 'b', 'server_bots', 'uploads'];
    for (const s of seeds) {
      // 两级上跳，normalize 后仍保留 ..
      assert.throws(
        () => InputValidator.validatePath(`${s}/../../outside`, dataRoot),
        RuntimeError
      );
    }
  });

  it('允许 data 下合法嵌套', () => {
    const ok = InputValidator.validatePath('server_bots/demo/config.yaml', dataRoot);
    assert.ok(ok.includes('server_bots'));
    assert.ok(ok.includes('config.yaml'));
  });
});
