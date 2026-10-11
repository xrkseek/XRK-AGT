import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPathLike, inlineBinaryFromRef } from '#utils/media-ref.js';

describe('isPathLike · 真路径应判 true', () => {
  it('Unix 绝对路径', () => {
    assert.equal(isPathLike('/var/data/a.png'), true);
  });

  it('相对路径前缀 ./ ../', () => {
    assert.equal(isPathLike('./a.png'), true);
    assert.equal(isPathLike('../a.png'), true);
  });

  it('file:// URL', () => {
    assert.equal(isPathLike('file:///C:/x/a.png'), true);
    assert.equal(isPathLike('FILE:///x'), true);
  });

  it('Windows 盘符路径（正反斜杠皆可）', () => {
    assert.equal(isPathLike('C:\\data\\a.png'), true);
    assert.equal(isPathLike('d:/data/a.png'), true);
  });

  it('含斜杠的任意串', () => {
    assert.equal(isPathLike('some/dir/file'), true);
    assert.equal(isPathLike('some\\dir\\file'), true);
  });

  it('纯文件名 + 已知媒体扩展名（无斜杠）', () => {
    assert.equal(isPathLike('a.jpg'), true);
    assert.equal(isPathLike('a.JPEG'), true);
    assert.equal(isPathLike('voice.silk'), true);
    assert.equal(isPathLike('x.amr'), true);
    assert.equal(isPathLike('x.bin'), true);
  });

  it('首尾空白先 trim 再判', () => {
    assert.equal(isPathLike('  /var/a.png  '), true);
  });
});

describe('isPathLike · 非路径应判 false（防二进制误填进 file 段）', () => {
  it('非字符串 / 空值 → false', () => {
    assert.equal(isPathLike(null), false);
    assert.equal(isPathLike(undefined), false);
    assert.equal(isPathLike(123), false);
    assert.equal(isPathLike({}), false);
    assert.equal(isPathLike(''), false);
    assert.equal(isPathLike('    '), false);
  });

  it('超长串 → false（>4096 上限）', () => {
    assert.equal(isPathLike('a'.repeat(4097)), false);
  });

  it('二进制魔数开头一律 false', () => {
    assert.equal(isPathLike('GIF89a......'), false);
    assert.equal(isPathLike('\x89PNG\r\n\x1a\n....'), false);
    assert.equal(isPathLike('RIFF....WAVE'), false);
    assert.equal(isPathLike('\xFF\xD8\xFF\xE0JFIF'), false);
    assert.equal(isPathLike('PK\u0003\u0004zip'), false);
  });

  it('含 NUL 或非法控制字符 → false', () => {
    assert.equal(isPathLike('ab\u0000cd'), false);
    assert.equal(isPathLike('ab\u0001cd'), false);
    assert.equal(isPathLike('ab\u0008cd'), false);
  });

  it('tab/CR/LF 不算非法控制字符（其余如 0x01 会被挡）', () => {
    // 只有含斜杠形态才成立：裸多行文本没有斜杠也不匹配扩展名，仍判 false
    assert.equal(isPathLike('dir/a\nb.png'), true);
    assert.equal(isPathLike('line1\nline2'), false);
    assert.equal(isPathLike('a\tb'), false);
  });

  it('无斜杠无已知扩展名的裸词 → false', () => {
    assert.equal(isPathLike('hello'), false);
    assert.equal(isPathLike('photo'), false);
    assert.equal(isPathLike('a.txt'), false);
  });

  it('https URL 不算路径（另有 base64:// 与 http 前置排除）', () => {
    // isPathLike 本身不排除 http；但 https:// 含 '/' 会被判 true，
    // 故 inlineBinaryFromRef 需先自行排除 URL。此处只锁 isPathLike 现状。
    assert.equal(isPathLike('https://example.com/a'), true);
  });
});

describe('inlineBinaryFromRef', () => {
  it('GIF 头还原为 Buffer（按 latin1 保字节）', () => {
    // 前置校验要求长度 >= 12，魔数占 6 字节，故补足到 12+
    const ref = `GIF89a${String.fromCharCode(1, 2, 3, 4, 5, 6, 7)}`;
    const buf = inlineBinaryFromRef(ref);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.toString('latin1'), ref);
    assert.equal(buf.length, ref.length);
  });

  it('PNG 头还原为 Buffer', () => {
    const ref = '\x89PNG\r\n\x1a\n\x00\x00\x00\x00';
    const buf = inlineBinaryFromRef(ref);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf[0], 0x89);
  });

  it('RIFF / JPEG 头还原为 Buffer', () => {
    assert.ok(Buffer.isBuffer(inlineBinaryFromRef('RIFF____WAVEfmt ')));
    assert.ok(Buffer.isBuffer(inlineBinaryFromRef('\xFF\xD8\xFF\xE0JFIF\u0000\u0001ABCD')));
  });

  it('非字符串 → null', () => {
    assert.equal(inlineBinaryFromRef(null), null);
    assert.equal(inlineBinaryFromRef(undefined), null);
    assert.equal(inlineBinaryFromRef(123), null);
  });

  it('过短串 → null（连 12 字节前置校验都不过）', () => {
    assert.equal(inlineBinaryFromRef('GIF8'), null);
    assert.equal(inlineBinaryFromRef('GIF89a123'), null);
  });

  it('base64:// 前缀 → null', () => {
    assert.equal(inlineBinaryFromRef('base64://R0lGODlh'), null);
  });

  it('http(s) URL → null（先于 isPathLike 排除，避免当路径）', () => {
    assert.equal(inlineBinaryFromRef('https://example.com/a.png'), null);
    assert.equal(inlineBinaryFromRef('  http://example.com/a.png  '), null);
  });

  it('真路径 → null（不是误填的二进制）', () => {
    assert.equal(inlineBinaryFromRef('/var/data/a.png'), null);
    assert.equal(inlineBinaryFromRef('C:\\data\\a.png'), null);
  });

  it('普通文本 → null', () => {
    assert.equal(inlineBinaryFromRef('hello world this is text'), null);
  });

  it('ZIP 魔数不进 inlineBinaryFromRef（此函数只认图/音视频四头）', () => {
    assert.equal(inlineBinaryFromRef('PK\u0003\u0004zipdata'), null);
  });
});
