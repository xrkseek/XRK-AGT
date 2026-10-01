import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolNameMapper } from '#utils/llm/tool-name-utils.js';

describe('createToolNameMapper · normalize', () => {
  it('合法名原样返回（不建立映射，避免无谓开销）', () => {
    const m = createToolNameMapper();
    assert.equal(m.normalize('read_file'), 'read_file');
    assert.equal(m.normalize('Tool-99'), 'Tool-99');
    assert.equal(m.normalize('a'), 'a');
  });

  it('点号 → 下划线（MCP 常见 server.tool 命名）', () => {
    const m = createToolNameMapper();
    assert.equal(m.normalize('mcp__server.tool'), 'mcp__server_tool');
  });

  it('非法字符 → 下划线', () => {
    const m = createToolNameMapper();
    assert.equal(m.normalize('weird name!@#'), 'weird_name___');
  });

  it('超 64 字符截断（OpenAI 上限）', () => {
    const m = createToolNameMapper();
    const out = m.normalize('a'.repeat(200));
    assert.equal(out.length, 64);
  });

  it('首位数字加 tool_ 前缀（上游不接受纯数字开头）', () => {
    const m = createToolNameMapper();
    assert.equal(m.normalize('1st_tool'), 'tool_1st_tool');
    assert.equal(m.normalize('9'), 'tool_9');
  });

  it('空/非字符串透传原值（不制造垃圾映射）', () => {
    const m = createToolNameMapper();
    assert.equal(m.normalize(''), '');
    assert.equal(m.normalize(null), null);
    assert.equal(m.normalize(undefined), undefined);
    assert.equal(m.normalize(42), 42);
    assert.equal(m.normalize({ a: 1 }).a, 1);
  });

  it('全非法字符逐个替换为下划线（不塌成空）', () => {
    const m = createToolNameMapper();
    assert.equal(m.normalize('!!!'), '___');
  });

  it('normalize("") 不走兜底（空值提前透传，故 tool 兜底实为防御分支）', () => {
    const m = createToolNameMapper();
    // 非空串经 replace/substring 后不可能为空，源码里 `if (!normalized) normalized = 'tool'`
    // 属不可达的防御分支；此处锁住「空输入不被改名」这一真实契约。
    assert.equal(m.normalize(''), '');
  });
});

describe('createToolNameMapper · denormalize 还原', () => {
  it('被规范化过的名字能还原为原始名（MCP 执行前必须还原）', () => {
    const m = createToolNameMapper();
    const original = 'mcp__filesystem.read_file';
    const normalized = m.normalize(original);
    assert.notEqual(normalized, original);
    assert.equal(m.denormalize(normalized), original);
  });

  it('未登记的名字原样返回（幂等，不查表失败）', () => {
    const m = createToolNameMapper();
    assert.equal(m.denormalize('never_seen'), 'never_seen');
  });

  it('两个原名规范化后撞到同一个键 → 都还原成最后登记的那个（已知的理论碰撞）', () => {
    const m = createToolNameMapper();
    m.normalize('a.b');
    m.normalize('a b');
    // 两者都规范化成 a_b，Map 保留最后一次登记
    assert.equal(m.denormalize('a_b'), 'a b');
  });
});

describe('createToolNameMapper · normalizeTools', () => {
  it('递归改写 function.name，保留其他字段', () => {
    const m = createToolNameMapper();
    const out = m.normalizeTools([
      { type: 'function', function: { name: 'srv.do_thing', description: 'd', parameters: {} } },
    ]);
    assert.equal(out[0].function.name, 'srv_do_thing');
    assert.equal(out[0].function.description, 'd');
    assert.deepEqual(out[0].function.parameters, {});
  });

  it('不修改入参（无副作用）', () => {
    const m = createToolNameMapper();
    const input = [{ type: 'function', function: { name: 'srv.do_thing' } }];
    m.normalizeTools(input);
    assert.equal(input[0].function.name, 'srv.do_thing');
  });

  it('非 function 类型 / 缺 function / 缺 name 原样透传', () => {
    const m = createToolNameMapper();
    const input = [
      { type: 'retrieval' },
      { type: 'function' },
      { type: 'function', function: {} },
    ];
    const out = m.normalizeTools(input);
    assert.deepEqual(out, input);
  });

  it('非数组原样返回（不抛）', () => {
    const m = createToolNameMapper();
    assert.equal(m.normalizeTools(null), null);
    assert.equal(m.normalizeTools(undefined), undefined);
    assert.equal(m.normalizeTools({ type: 'function' }).type, 'function');
  });
});

describe('createToolNameMapper · normalizeMessages', () => {
  it('改写 role=tool 消息的 name', () => {
    const m = createToolNameMapper();
    const out = m.normalizeMessages([{ role: 'tool', name: 'srv.do_thing', content: 'ok' }]);
    assert.equal(out[0].name, 'srv_do_thing');
    assert.equal(out[0].content, 'ok');
  });

  it('改写 assistant 消息里 tool_calls 的 function.name', () => {
    const m = createToolNameMapper();
    const out = m.normalizeMessages([
      {
        role: 'assistant',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'srv.do_thing', arguments: '{}' } },
        ],
      },
    ]);
    assert.equal(out[0].tool_calls[0].function.name, 'srv_do_thing');
    assert.equal(out[0].tool_calls[0].function.arguments, '{}');
    assert.equal(out[0].tool_calls[0].id, 'c1');
  });

  it('tool_calls 为空数组时保持原样（不产生空替换）', () => {
    const m = createToolNameMapper();
    const out = m.normalizeMessages([{ role: 'assistant', tool_calls: [] }]);
    assert.deepEqual(out[0].tool_calls, []);
  });

  it('tool_call 缺 function.name 时不崩', () => {
    const m = createToolNameMapper();
    const out = m.normalizeMessages([{ role: 'assistant', tool_calls: [{ id: 'c1' }] }]);
    assert.equal(out[0].tool_calls[0].id, 'c1');
    assert.equal(out[0].tool_calls[0].function, undefined);
  });

  it('同时命中 name 与 tool_calls 时两者都规范化', () => {
    const m = createToolNameMapper();
    const out = m.normalizeMessages([
      { role: 'tool', name: 'srv.a', tool_calls: [{ function: { name: 'srv.b' } }] },
    ]);
    assert.equal(out[0].name, 'srv_a');
    assert.equal(out[0].tool_calls[0].function.name, 'srv_b');
  });

  it('普通 user/assistant 消息不新增字段', () => {
    const m = createToolNameMapper();
    const out = m.normalizeMessages([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(out, [{ role: 'user', content: 'hi' }]);
  });

  it('数组内的 null / 非对象元素原样透传', () => {
    const m = createToolNameMapper();
    const out = m.normalizeMessages([null, 'str', 42]);
    assert.deepEqual(out, [null, 'str', 42]);
  });

  it('不修改入参（无副作用）', () => {
    const m = createToolNameMapper();
    const input = [{ role: 'tool', name: 'srv.a' }];
    m.normalizeMessages(input);
    assert.equal(input[0].name, 'srv.a');
  });

  it('非数组原样返回', () => {
    const m = createToolNameMapper();
    assert.equal(m.normalizeMessages(null), null);
    assert.equal(m.normalizeMessages('x'), 'x');
  });
});

describe('createToolNameMapper · denormalizeToolCalls', () => {
  it('把规范化名还原为 MCP 真实工具名', () => {
    const m = createToolNameMapper();
    const original = 'mcp__filesystem.read_file';
    const normalized = m.normalize(original);
    const out = m.denormalizeToolCalls([{ id: 'c1', function: { name: normalized, arguments: '{}' } }]);
    assert.equal(out[0].function.name, original);
    assert.equal(out[0].function.arguments, '{}');
  });

  it('缺 function.name 的 tool_call 原样透传', () => {
    const m = createToolNameMapper();
    const out = m.denormalizeToolCalls([{ id: 'c1' }]);
    assert.deepEqual(out, [{ id: 'c1' }]);
  });

  it('非数组原样返回', () => {
    const m = createToolNameMapper();
    assert.equal(m.denormalizeToolCalls(null), null);
  });
});

describe('createToolNameMapper · 出入站往返', () => {
  it('normalize → denormalize 对多类非法名都还原（不丢工具）', () => {
    const m = createToolNameMapper();
    for (const original of [
      'mcp__server.read file',
      '1st.tool',
      'weird!!name',
      'a'.repeat(100),
    ]) {
      assert.equal(m.denormalize(m.normalize(original)), original, original);
    }
  });
});
