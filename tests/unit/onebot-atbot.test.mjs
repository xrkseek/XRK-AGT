import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import OneBotEnhancer from '../../dist/core/system-Core/plugin/OneBotEnhancer.js';

describe('OneBotEnhancer atBot（data.qq）', () => {
  it('识别 NapCat 嵌套 data.qq 的 @机器人', () => {
    const enhancer = new OneBotEnhancer();
    const e = {
      self_id: '3484504812',
      message: [
        { type: 'at', data: { qq: 3484504812 } },
        { type: 'text', data: { text: ' 在？' } },
      ],
    };
    enhancer.processAtProperties(e);
    assert.equal(e.atBot, true);
    assert.deepEqual(e.atList, ['3484504812']);
  });

  it('识别扁平 qq 字段', () => {
    const enhancer = new OneBotEnhancer();
    const e = {
      self_id: '1',
      message: [{ type: 'at', qq: '1' }, { type: 'text', text: 'hi' }],
    };
    enhancer.processAtProperties(e);
    assert.equal(e.atBot, true);
  });

  it('@别人不置 atBot', () => {
    const enhancer = new OneBotEnhancer();
    const e = {
      self_id: '3484504812',
      message: [{ type: 'at', data: { qq: '1517106354' } }],
    };
    enhancer.processAtProperties(e);
    assert.equal(e.atBot, undefined);
    assert.equal(e.at, '1517106354');
  });
});
