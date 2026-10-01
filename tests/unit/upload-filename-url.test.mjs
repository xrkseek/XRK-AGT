import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMulterFilename } from '#utils/multipart-filename.js';
import { resolveClientBaseUrl } from '#utils/client-base-url.js';

describe('decodeMulterFilename', () => {
  it('纠正 UTF-8 被按 Latin-1 误读的中文名', () => {
    const orig = '2026年春思政课实践教学手册(概论).docx';
    const mojibake = Buffer.from(orig, 'utf8').toString('latin1');
    assert.equal(decodeMulterFilename(mojibake), orig);
  });

  it('已是正常 UTF-8 时不改动', () => {
    assert.equal(decodeMulterFilename('报告.pdf'), '报告.pdf');
  });

  it('去掉路径段', () => {
    assert.equal(decodeMulterFilename('a/b/c.txt'), 'c.txt');
  });
});

describe('resolveClientBaseUrl', () => {
  it('优先请求 Host，避免返回 127.0.0.1', () => {
    const req = {
      protocol: 'http',
      get: (h) => (h === 'host' ? '115.190.181.211:11451' : undefined),
      headers: {},
    };
    const url = resolveClientBaseUrl(req, { url: 'http://127.0.0.1:11451' });
    assert.equal(url, 'http://115.190.181.211:11451');
  });

  it('尊重 X-Forwarded-Proto', () => {
    const req = {
      protocol: 'http',
      get: (h) => {
        if (h === 'host') return 'example.com';
        if (h === 'x-forwarded-proto') return 'https';
        return undefined;
      },
      headers: {},
    };
    assert.equal(resolveClientBaseUrl(req, {}), 'https://example.com');
  });
});
