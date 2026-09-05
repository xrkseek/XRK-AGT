import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { InputValidator } from '#utils/input-validator.js';
import { RuntimeError, ErrorCodes } from '#utils/error-handler.js';

const dataRoot = path.join(process.cwd(), 'data');
const uploads = path.join(dataRoot, 'uploads');

describe('InputValidator 路径安全', () => {
  it('允许 data 根下相对路径', () => {
    const resolved = InputValidator.validatePath('server_bots/test.yaml', dataRoot);
    assert.ok(resolved.includes('server_bots'));
    assert.equal(path.resolve(resolved), resolved);
  });

  it('允许 baseDir 内的绝对路径（multer 落盘场景）', () => {
    const abs = path.join(uploads, '1b3684a4-a01a-49bb-9cd7-f63cfaed3539.docx');
    const resolved = InputValidator.validatePath(abs, uploads);
    assert.equal(resolved, path.resolve(abs));
  });

  it('允许文件名含 .. 子串但不跳出目录', () => {
    const resolved = InputValidator.validatePath('foo..bar.docx', uploads);
    assert.ok(resolved.endsWith(`${path.sep}foo..bar.docx`));
  });

  it('拒绝路径穿越', () => {
    assert.throws(
      () => InputValidator.validatePath('../../../etc/passwd', dataRoot),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_PATH,
    );
  });

  it('拒绝 baseDir 外的绝对路径', () => {
    assert.throws(
      () => InputValidator.validatePath('/etc/passwd', dataRoot),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_PATH,
    );
  });
});
