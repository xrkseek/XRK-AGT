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

  it('拒绝非字符串入参', () => {
    assert.throws(
      () => InputValidator.validatePath(null, dataRoot),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
    assert.throws(
      () => InputValidator.validatePath(42, dataRoot),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
  });

  it('拒绝含 NUL 字节的路径', () => {
    assert.throws(
      () => InputValidator.validatePath('hello\u0000world.txt', dataRoot),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.PATH_TRAVERSAL,
    );
  });

  it('允许 URL 编码路径（%20 空格），解析回原始字节', () => {
    const decoded = 'my file.txt';
    const resolved = InputValidator.validatePath(encodeURIComponent(decoded), uploads);
    assert.ok(resolved.endsWith(decoded));
  });
});

describe('InputValidator assertPathUnderRoots', () => {
  const roots = [dataRoot, uploads];

  it('允许位于任一允许根内的绝对路径', () => {
    const inside = path.join(uploads, 'a.docx');
    const resolved = InputValidator.assertPathUnderRoots(inside, roots);
    assert.equal(resolved, path.resolve(inside));
  });

  it('拒绝位于所有允许根之外的绝对路径', () => {
    assert.throws(
      () => InputValidator.assertPathUnderRoots('C:/Windows/System32/drivers/etc/hosts', roots),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_PATH,
    );
  });

  it('拒绝相对路径（只支持绝对路径）', () => {
    assert.throws(
      () => InputValidator.assertPathUnderRoots('server_bots/test.yaml', roots),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_PATH,
    );
  });

  it('拒绝非字符串入参', () => {
    assert.throws(
      () => InputValidator.assertPathUnderRoots(undefined, roots),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
  });
});

describe('InputValidator validateCommand', () => {
  const dangerous = [
    'rm -rf /tmp/x',
    'echo x | format c:',
    'del /f C:\\x.txt',
    'rmdir /s C:\\x',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'cat /dev/sda1 > /dev/null',
    'cmd | sh',
    'cmd | bash',
  ];

  for (const cmd of dangerous) {
    it(`拒绝危险命令: ${cmd}`, () => {
      assert.throws(
        () => InputValidator.validateCommand(cmd),
        (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_COMMAND,
      );
    });
  }

  it('允许并 trim 安全命令', () => {
    assert.equal(InputValidator.validateCommand('  git status  '), 'git status');
  });

  it('拒绝非字符串入参', () => {
    assert.throws(
      () => InputValidator.validateCommand(undefined),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
  });
});

describe('InputValidator validateUserId / validatePort', () => {
  it('validateUserId 接受纯数字（含字符串形式）', () => {
    assert.equal(InputValidator.validateUserId(123), '123');
    assert.equal(InputValidator.validateUserId('456'), '456');
  });

  it('validateUserId 拒绝空', () => {
    assert.throws(
      () => InputValidator.validateUserId(''),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
  });

  it('validateUserId 拒绝非纯数字', () => {
    assert.throws(
      () => InputValidator.validateUserId('abc'),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
  });

  it('validatePort 接受 1-65535', () => {
    assert.equal(InputValidator.validatePort(1), 1);
    assert.equal(InputValidator.validatePort('8080'), 8080);
    assert.equal(InputValidator.validatePort(65535), 65535);
  });

  it('validatePort 拒绝越界与非法输入', () => {
    for (const bad of [0, -1, 65536, 'abc', null]) {
      assert.throws(
        () => InputValidator.validatePort(bad),
        (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
        `port=${String(bad)} 应被拒绝`,
      );
    }
  });
});

describe('InputValidator validateUrl / validateJson', () => {
  it('validateUrl 接受 http/https', () => {
    assert.equal(InputValidator.validateUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(InputValidator.validateUrl('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  });

  it('validateUrl 拒绝非 http(s) 协议', () => {
    assert.throws(
      () => InputValidator.validateUrl('file:///etc/passwd'),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
    assert.throws(
      () => InputValidator.validateUrl('ftp://example.com/x'),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
  });

  it('validateUrl 拒绝畸形 URL 与非字符串', () => {
    assert.throws(
      () => InputValidator.validateUrl('not a url'),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
    assert.throws(
      () => InputValidator.validateUrl(''),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
  });

  it('validateJson 解析合法 JSON', () => {
    assert.deepEqual(InputValidator.validateJson('{"a":1}'), { a: 1 });
    assert.deepEqual(InputValidator.validateJson('[1,2]'), [1, 2]);
  });

  it('validateJson 拒绝非法 JSON 与非字符串', () => {
    assert.throws(
      () => InputValidator.validateJson('{bad'),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
    assert.throws(
      () => InputValidator.validateJson(null),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
  });
});

describe('InputValidator sanitizeText / validateApiKey', () => {
  it('sanitizeText 移除控制字符、保留换行与制表符', () => {
    const out = InputValidator.sanitizeText('a\u0000b\u0007c\nd\te');
    assert.equal(out, 'abc\nd\te', '仅 \x00/\x07 被移除，换行与制表符保留');
  });

  it('sanitizeText 截断超长文本并标注', () => {
    const long = 'x'.repeat(200);
    const out = InputValidator.sanitizeText(long, 10);
    assert.ok(out.startsWith('x'.repeat(10)));
    assert.ok(out.endsWith('...(已截断)'));
    assert.ok(out.length < 30);
  });

  it('sanitizeText 非字符串/空返回空串', () => {
    assert.equal(InputValidator.sanitizeText(undefined), '');
    assert.equal(InputValidator.sanitizeText(''), '');
  });

  it('sanitizeText 保留 trim 语义', () => {
    assert.equal(InputValidator.sanitizeText('  hi  '), 'hi');
  });

  it('validateApiKey 接受 16-256 字符', () => {
    const key = 'k'.repeat(16);
    assert.equal(InputValidator.validateApiKey(key), key);
    assert.equal(InputValidator.validateApiKey('k'.repeat(256)), 'k'.repeat(256));
  });

  it('validateApiKey 拒绝过短/过长/非字符串', () => {
    assert.throws(
      () => InputValidator.validateApiKey('short'),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
    assert.throws(
      () => InputValidator.validateApiKey('k'.repeat(257)),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
    assert.throws(
      () => InputValidator.validateApiKey(null),
      (err) => err instanceof RuntimeError && err.code === ErrorCodes.INVALID_INPUT,
    );
  });
});