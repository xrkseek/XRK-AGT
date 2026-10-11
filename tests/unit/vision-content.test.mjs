/**
 * 跨通道视觉标准层：单元契约（CI 快路径）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgtUserContent,
  buildOpenAIVisionParts,
  coerceVisionRefList,
  countVisionInContent,
  decodeHtmlEntitiesInUrl,
  extractVisionFromSegments,
  mergeUploadedImagesIntoMessages,
  normalizeVisionRef
} from '../../dist/src/utils/llm/vision-content.js';
import { transformMessagesWithVision } from '../../dist/src/utils/llm/message-transform.js';

describe('vision-content 标准层', () => {
  it('decodeHtmlEntitiesInUrl 还原 QQ CDN &amp;', () => {
    const u = decodeHtmlEntitiesInUrl('https://x.test/?a=1&amp;b=2');
    assert.equal(u, 'https://x.test/?a=1&b=2');
  });

  it('extractVisionFromSegments 区分引用图与当前图', () => {
    const { images, replyImages } = extractVisionFromSegments([
      { type: 'reply', id: '9' },
      { type: 'image', file: 'R.jpg', url: 'https://cdn/r.jpg&amp;x=1' },
      { type: 'text', text: '看' },
      { type: 'image', file: 'A.jpg' },
      { type: 'image', file: 'B.jpg' }
    ]);
    assert.equal(replyImages.length, 1);
    assert.equal(replyImages[0].ref, 'R.jpg');
    assert.equal(images.length, 2);
    assert.deepEqual(images.map((x) => x.ref), ['A.jpg', 'B.jpg']);
  });

  it('跳过 sticker sub_type=1', () => {
    const { images } = extractVisionFromSegments([
      { type: 'image', file: 'sticker.png', sub_type: 1 },
      { type: 'image', file: 'photo.jpg', sub_type: 0 }
    ]);
    assert.deepEqual(images.map((x) => x.ref), ['photo.jpg']);
  });

  it('buildAgtUserContent 无图退化为 string', () => {
    assert.equal(buildAgtUserContent({ text: 'hi' }), 'hi');
  });

  it('buildOpenAIVisionParts 多图带标注且可截断', () => {
    const parts = buildOpenAIVisionParts(
      {
        text: '描述',
        replyImages: ['http://r'],
        images: ['http://a', 'http://b', 'http://c']
      },
      { visionMaxImages: 2 }
    );
    const texts = parts.filter((p) => p.type === 'text').map((p) => p.text);
    const imgs = parts.filter((p) => p.type === 'image_url');
    assert.ok(texts.some((t) => t.includes('引用附图')));
    assert.equal(imgs.length, 2);
    assert.ok(texts.some((t) => t.includes('截断')));
  });

  it('transformMessagesWithVision openai 模式产出 parts', async () => {
    const out = await transformMessagesWithVision(
      [
        {
          role: 'user',
          content: { text: 't', images: ['http://a'], replyImages: ['http://b'] }
        }
      ],
      {},
      { mode: 'openai' }
    );
    assert.ok(Array.isArray(out[0].content));
    assert.ok(countVisionInContent(out[0].content) >= 2);
  });

  it('mergeUploadedImagesIntoMessages 支持 image_roles', () => {
    const messages = [{ role: 'user', content: '看图' }];
    mergeUploadedImagesIntoMessages(messages, ['http://r', 'http://c'], {
      roles: ['reply', 'current']
    });
    assert.deepEqual(messages[0].content.replyImages, ['http://r']);
    assert.deepEqual(messages[0].content.images, ['http://c']);
  });

  it('coerceVisionRefList 去重并接受对象 ref', () => {
    const list = coerceVisionRefList([
      'http://a',
      { ref: 'http://a' },
      { url: 'http://b', role: 'current' }
    ]);
    assert.equal(list.length, 2);
    assert.equal(normalizeVisionRef({ file: 'x.jpg' })?.ref, 'x.jpg');
  });
});
