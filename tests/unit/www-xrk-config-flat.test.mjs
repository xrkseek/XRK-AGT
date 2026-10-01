/**
 * www/xrk config/flat.js 行为测试。
 *
 * 历史上这份测试只做「源码 contains export function X(」的文本匹配——不执行代码，
 * 断言形同虚设（且其中一行正则两边字面量完全相同）。现通过 xrk-www-alias hook
 * 把 `@/` 别名映射到 www 源码，真正 import 模块做行为级断言。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installXrkAliasHook } from '../helpers/xrk-www-alias.mjs';

// 必须先装 hook 再 import flat.js（其内部 `import { deepClone } from '@/utils/http'`）
installXrkAliasHook();
const flat = await import('../../core/system-Core/www/xrk/src/config/flat.js');

const {
  getNestedValue,
  setNestedValue,
  castFieldValue,
  normalizeFlatFields,
  resolveFieldControl,
  normalizeOptions,
  formatTagsText,
  parseTagsText,
  canonicalizeArrayObjectValue,
  canonicalizeObjectByFields,
  buildDirtyFlat,
  buildDefaultsFromFields,
  applyFlatJsonObject,
} = flat;

describe('flat.js fallback 路径安全', () => {
  it('getNestedValue 深读（空 path 返回原对象）', () => {
    assert.equal(getNestedValue({ a: { b: 1 } }, 'a.b'), 1);
    assert.equal(getNestedValue({ a: 1 }, 'x.y'), undefined);
    // 空 path 走 if (!path) return obj —— 是引用返回，非深拷贝
    const src = { a: 1 };
    assert.ok(Object.is(getNestedValue(src, ''), src));
  });

  it('setNestedValue 纯函数返回新对象，不改入参', () => {
    const src = {};
    const out = setNestedValue(src, 'a.b.c', 42);
    assert.deepEqual(out, { a: { b: { c: 42 } } });
    assert.deepEqual(src, {}, '入参不得被修改（签名是纯函数）');
    // 数字段下一层自动建数组
    assert.deepEqual(setNestedValue({}, 'a.0.b', 1), { a: [{ b: 1 }] });
  });
});

describe('flat.js castFieldValue 类型转换', () => {
  it('number 系：空→null，非有限→原值', () => {
    assert.equal(castFieldValue('3.14', 'number'), 3.14);
    assert.equal(castFieldValue('', 'number'), null);
    assert.equal(castFieldValue('abc', 'number'), 'abc');
  });

  it('boolean / switch：字符串别名表', () => {
    assert.equal(castFieldValue('true', 'boolean'), true);
    assert.equal(castFieldValue('off', 'boolean'), false);
    assert.equal(castFieldValue(1, 'boolean'), true);
  });

  it('array<object> / arrayform：数组保留，非数组回空数组', () => {
    assert.deepEqual(castFieldValue([{ a: 1 }], 'array<object>'), [{ a: 1 }]);
    assert.deepEqual(castFieldValue(' a, b ,c ', 'array<object>'), []);
    assert.deepEqual(castFieldValue(null, 'array<object>'), []);
  });

  it('array：CSV 字符串拆成数组；tags（非 array type）不拆', () => {
    // 契约澄清：只有 type==='array' 才拆 CSV；type==='tags' 不命中任何分支故原样返回
    assert.deepEqual(castFieldValue(' a, b ,c ', 'array'), ['a', 'b', 'c']);
    assert.equal(castFieldValue(' a, b ,c ', 'tags'), ' a, b ,c ');
    assert.deepEqual(castFieldValue(['x', 'y'], 'tags'), ['x', 'y']);
    assert.equal(castFieldValue(null, 'tags'), null);
  });

  it('object / json：JSON 解析只认 component=json，type=json 不命中', () => {
    assert.equal(castFieldValue('{"k":1}', 'json'), '{"k":1}');
    assert.deepEqual(castFieldValue('{"k":1}', 'object', 'json'), { k: 1 });
    assert.deepEqual(castFieldValue('not-json', 'object', 'subform'), {});
    assert.deepEqual(castFieldValue({ k: 2 }, 'object'), { k: 2 });
  });
});

describe('flat.js 结构推导', () => {
  it('normalizeFlatFields 数组化 + 过滤无标识 / 模板项', () => {
    // 契约：字段标识取 raw.path || raw.key || raw.name || meta.path
    const out = normalizeFlatFields([
      { path: 'a' },
      null,
      { name: 'b' },
      { path: 'providers[].model' }, // 模板路径首轮跳过
      { path: 'c', label: 'C' },
    ]);
    assert.ok(Array.isArray(out));
    assert.deepEqual(
      out.map((f) => f.path),
      ['a', 'b', 'c'],
    );
  });

  it('resolveFieldControl 返回非空', () => {
    assert.ok(resolveFieldControl('demo', { demo: { control: 'input' } }));
  });
});

describe('flat.js 标签/选项工具', () => {
  const opts = [{ label: 'A', value: 1 }, { label: 'B', value: 2 }];

  it('normalizeOptions 输出 label/value', () => {
    const out = normalizeOptions(opts);
    assert.ok(Array.isArray(out));
    assert.equal(out[0].value, 1);
  });

  it('formatTagsText / parseTagsText 往返', () => {
    const tags = ['a', 'b'];
    assert.equal(formatTagsText(tags), 'a, b');
    assert.deepEqual(parseTagsText(' a , b '), ['a', 'b']);
  });
});

describe('flat.js 脏标记/默认值/合并', () => {
  it('buildDirtyFlat：仅输出相对 original 变化的字段', () => {
    // 契约：fields 是字段数组，字段标识用 f.path
    const fields = [
      { path: 'a', type: 'string' },
      { path: 'b', type: 'string' },
    ];
    const dirty = buildDirtyFlat({ a: 'x', b: 'same' }, { a: 'old', b: 'same' }, fields);
    assert.deepEqual(dirty, { a: 'x' });
  });

  it('buildDefaultsFromFields 按 key→schema 映射产默认值', () => {
    // 契约：入参是 Record<key, schema>，非数组（数组会退化成索引键）
    assert.deepEqual(
      buildDefaultsFromFields({ x: { type: 'number', default: 5 } }),
      { x: 5 },
    );
    // 无 default 时按控件给零值：switch→false / number→null / array→[]
    assert.deepEqual(
      buildDefaultsFromFields({
        sw: { type: 'boolean' },
        num: { type: 'number' },
        tags: { type: 'array' },
      }),
      { sw: false, num: null, tags: [] },
    );
  });

  it('applyFlatJsonObject 走 valuesFromFlat，字段用 f.path + 控件零值', () => {
    const fields = [
      { path: 'a', type: 'string' },
      { path: 'sw', component: 'switch' },
      { path: 'num', component: 'inputnumber' },
      { path: 'tags', component: 'tags' },
    ];
    const out = applyFlatJsonObject({ a: 'x' }, fields);
    assert.equal(out.a, 'x');
    // 未出现在 JSON 里的字段按控件补零值
    assert.equal(out.sw, false);
    assert.equal(out.num, null);
    assert.deepEqual(out.tags, []);
  });
});

describe('canonicalize* 的 schema 规范化', () => {
  it('canonicalizeObjectByFields 非对象入参按空对象处理，但已知键仍补零值', () => {
    assert.deepEqual(canonicalizeObjectByFields(null), {});
    // 数组/字符串都被当作空对象；但 schema 里声明的键照样走 canonicalizeFieldValue
    assert.deepEqual(canonicalizeObjectByFields([1, 2], { a: { type: 'string' } }), { a: '' });
    assert.deepEqual(canonicalizeObjectByFields(undefined, { n: { type: 'number' } }), { n: null });
  });

  it('canonicalizeObjectByFields 按 schema 规范化已知键', () => {
    const out = canonicalizeObjectByFields(
      { n: '42', sw: 'yes', tags: 'x', bad: 'zz' },
      { n: { type: 'number' }, sw: { component: 'switch' }, tags: { component: 'tags' }, bad: { type: 'number' } },
    );
    // bad: 'zz' → Number('zz') 非有限，原值回落，不丢用户输入
    // tags: 'x' → canonicalizeFieldValue 内部先调 castFieldValue，字符串按逗号切分
    assert.deepEqual(out, { n: 42, sw: true, tags: ['x'], bad: 'zz' });
    assert.deepEqual(
      canonicalizeObjectByFields({ tags: 'a, b ,c' }, { tags: { component: 'tags' } }),
      { tags: ['a', 'b', 'c'] },
    );
  });

  it('canonicalizeObjectByFields 保留 schema 外的自定义键，且是深拷贝', () => {
    const src = { known: 'a', custom: { deep: 1 } };
    const out = canonicalizeObjectByFields(src, { known: { type: 'string' } });
    assert.deepEqual(out, { known: 'a', custom: { deep: 1 } });
    out.custom.deep = 2;
    assert.equal(src.custom.deep, 1, '未知键必须深拷贝，不能与入参共享引用');
  });

  it('canonicalizeObjectByFields 递归 subform，非对象的 schema 条目跳过', () => {
    const out = canonicalizeObjectByFields(
      { sub: { inner: '7' } },
      { sub: { type: 'object', fields: { inner: { type: 'number' } } }, broken: null },
    );
    assert.deepEqual(out, { sub: { inner: 7 } });
  });

  it('canonicalizeArrayObjectValue 非数组回退空数组', () => {
    assert.deepEqual(canonicalizeArrayObjectValue('x'), []);
    assert.deepEqual(canonicalizeArrayObjectValue(null), []);
  });

  it('canonicalizeArrayObjectValue 无 itemFields 时逐项深拷贝，非对象项回退空对象', () => {
    const src = [{ a: 1 }];
    const out = canonicalizeArrayObjectValue(src);
    assert.deepEqual(out, [{ a: 1 }]);
    out[0].a = 2;
    assert.equal(src[0].a, 1, '应深拷贝，不共享引用');
    assert.deepEqual(canonicalizeArrayObjectValue(['junk']), [{}]);
  });

  it('canonicalizeArrayObjectValue 有 itemFields 时逐项走 schema 规范化', () => {
    const out = canonicalizeArrayObjectValue([{ n: '3' }, 'junk'], { n: { type: 'number' } });
    assert.deepEqual(out, [{ n: 3 }, { n: null }]);
  });
});