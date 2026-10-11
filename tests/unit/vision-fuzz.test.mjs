/**
 * 视觉引用模糊 / 属性测试（CI）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenAIVisionParts,
  coerceVisionRefList,
  decodeHtmlEntitiesInUrl,
  extractVisionFromSegments,
  normalizeVisionRef
} from '../../dist/src/utils/llm/vision-content.js';

describe('vision 模糊 / 属性', () => {
  it('任意垃圾输入 normalizeVisionRef 不抛且无有效则 null', () => {
    const junk = [null, undefined, '', '   ', 0, false, {}, [], { foo: 1 }, Symbol('x')];
    for (const j of junk) {
      assert.equal(normalizeVisionRef(j), null);
    }
  });

  it('属性：coerce 后无重复 ref', () => {
    for (let n = 1; n <= 40; n++) {
      const raw = [];
      for (let i = 0; i < n; i++) {
        raw.push(`http://x/${i % 7}`);
        raw.push({ ref: `http://x/${i % 7}` });
      }
      const list = coerceVisionRefList(raw);
      const refs = list.map((x) => x.ref);
      assert.equal(refs.length, new Set(refs).size);
      assert.ok(refs.length <= 7);
    }
  });

  it('属性：entity 解码幂等', () => {
    const samples = [
      'https://a/?x=1',
      'https://a/?x=1&amp;y=2',
      'https://a/?x=1&amp;amp;y=2'
    ];
    for (const s of samples) {
      const once = decodeHtmlEntitiesInUrl(s);
      const twice = decodeHtmlEntitiesInUrl(once);
      assert.equal(once, twice);
      assert.ok(!once.includes('&amp;'));
    }
  });

  it('模糊段类型：未知 type 不产生幽灵图', () => {
    const weird = [
      { type: 'video', file: 'v.mp4' },
      { type: 'file', name: 'a.pdf' },
      { type: 'IMAGE', file: 'upper.jpg' }, // 大小写不敏感
      { type: 'unknown', url: 'http://x' },
      null,
      'plain'
    ];
    const { images, replyImages } = extractVisionFromSegments(weird);
    assert.equal(replyImages.length, 0);
    assert.deepEqual(images.map((x) => x.ref), ['upper.jpg']);
  });

  it('属性：maxImages 边界 1..N 截断后 image_url 数 ≤ max', () => {
    const imgs = Array.from({ length: 20 }, (_, i) => `http://i/${i}`);
    for (let max = 1; max <= 12; max++) {
      const parts = buildOpenAIVisionParts(
        { text: 't', images: imgs },
        { visionMaxImages: max }
      );
      const n = parts.filter((p) => p.type === 'image_url').length;
      assert.ok(n <= max, `max=${max} got=${n}`);
    }
  });
});
