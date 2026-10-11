import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectBotInventory, summarizeBots } from '#infrastructure/http/utils/botInventory.js';

/** 最小 protocol bot 桩：带 nickname/tasker 才会进列表 */
function protoBot(extra = {}) {
  return { nickname: 'bot', tasker: { name: 'OneBotv11' }, ...extra };
}

describe('collectBotInventory · 空输入', () => {
  it('AgentRuntime 缺失 / null → 空数组', async () => {
    assert.deepEqual(await collectBotInventory(null), []);
    assert.deepEqual(await collectBotInventory(undefined), []);
  });

  it('无 bots 字段 → 空数组', async () => {
    assert.deepEqual(await collectBotInventory({}), []);
    assert.deepEqual(await collectBotInventory({ bots: null }), []);
  });

  it('bots 为空对象 → 空数组', async () => {
    assert.deepEqual(await collectBotInventory({ bots: {} }), []);
  });
});

describe('collectBotInventory · 过滤', () => {
  it('null 条目被跳过', async () => {
    const out = await collectBotInventory({ bots: { a: protoBot(), b: null } });
    assert.equal(out.length, 1);
    assert.equal(out[0].uin, 'a');
  });

  it('非对象条目被跳过', async () => {
    const out = await collectBotInventory({ bots: { a: protoBot(), b: 'str', c: 42 } });
    assert.equal(out.length, 1);
  });

  it('保留键：port / apiKey / stdin / logger / url 等系统键不当作 bot', async () => {
    const bots = {
      port: { nickname: 'x', tasker: { name: 't' } },
      apiKey: { nickname: 'x', tasker: { name: 't' } },
      stdin: { nickname: 'x', tasker: { name: 't' } },
      logger: { nickname: 'x', tasker: { name: 't' } },
      url: { nickname: 'x', tasker: { name: 't' } },
      real: protoBot(),
    };
    const out = await collectBotInventory({ bots });
    assert.equal(out.length, 1);
    assert.equal(out[0].uin, 'real');
  });

  it('四要素全空的条目跳过（不产噪声行）', async () => {
    const out = await collectBotInventory({ bots: { empty: {}, other: protoBot() } });
    assert.equal(out.length, 1);
    assert.equal(out[0].uin, 'other');
  });
});

describe('collectBotInventory · 设备 bot', () => {
  it('device_type 存在 → device=true，tasker 按类型命名', async () => {
    const out = await collectBotInventory({
      bots: { d1: { device_type: 'web', online: true, nickname: 'Web Bot' } },
    });
    assert.deepEqual(out, [
      {
        uin: 'd1',
        device: true,
        online: true,
        nickname: 'Web Bot',
        tasker: 'Web客户端',
        stats: { friends: 0, groups: 0 },
      },
    ]);
  });

  it('非 web 设备：tasker 直接用 device_type', async () => {
    const out = await collectBotInventory({ bots: { d1: { device_type: 'android' } } });
    assert.equal(out[0].tasker, 'android');
  });

  it('online 未定义时视为在线（仅显式 false 才离线）', async () => {
    const out = await collectBotInventory({ bots: { d1: { device_type: 'web' } } });
    assert.equal(out[0].online, true);
    const out2 = await collectBotInventory({ bots: { d2: { device_type: 'web', online: false } } });
    assert.equal(out2[0].online, false);
  });

  it('昵称回退链 nickname → info.device_name → 设备', async () => {
    const withName = await collectBotInventory({
      bots: { d: { device_type: 'web', info: { device_name: 'Pixel' } } },
    });
    assert.equal(withName[0].nickname, 'Pixel');
    const bare = await collectBotInventory({ bots: { d: { device_type: 'web' } } });
    assert.equal(bare[0].nickname, '设备');
  });

  it('设备条目不查好友/群（stats 恒为 0）', async () => {
    let called = false;
    const out = await collectBotInventory({
      bots: {
        d: {
          device_type: 'web',
          getFriendMap: async () => {
            called = true;
            return new Map([['1', {}]]);
          },
        },
      },
    });
    assert.equal(called, false);
    assert.deepEqual(out[0].stats, { friends: 0, groups: 0 });
  });
});

describe('collectBotInventory · 协议 bot', () => {
  it('统计 stat.online，未定义时回落 _ready', async () => {
    const a = await collectBotInventory({ bots: { a: protoBot({ stat: { online: true } }) } });
    assert.equal(a[0].online, true);
    const b = await collectBotInventory({ bots: { b: protoBot({ _ready: true }) } });
    assert.equal(b[0].online, true);
    const c = await collectBotInventory({ bots: { c: protoBot() } });
    assert.equal(c[0].online, false);
    const d = await collectBotInventory({
      bots: { d: protoBot({ stat: { online: false }, _ready: true }) },
    });
    assert.equal(d[0].online, false, 'stat.online=false 优先于 _ready');
  });

  it('昵称回退 nickname → uin', async () => {
    const out = await collectBotInventory({ bots: { '10001': { tasker: { name: 't' } } } });
    assert.equal(out[0].nickname, '10001');
  });

  it('tasker 缺失时 tasker 名为 unknown', async () => {
    const out = await collectBotInventory({ bots: { a: { nickname: 'n' } } });
    assert.equal(out[0].tasker, 'unknown');
  });

  it('OneBotv11 且无 avatar 时补 QQ 头像 URL（用 bot.uin 而非字典键）', async () => {
    const out = await collectBotInventory({
      bots: { key: protoBot({ uin: '998877' }) },
    });
    assert.equal(out[0].avatar, 'https://q1.qlogo.cn/g?b=qq&nk=998877&s=100');
  });

  it('非 OneBotv11 无 avatar → null', async () => {
    const out = await collectBotInventory({
      bots: { a: { nickname: 'n', tasker: { name: 'Other' }, uin: '1' } },
    });
    assert.equal(out[0].avatar, null);
  });

  it('有 avatar 时优先用自带值', async () => {
    const out = await collectBotInventory({
      bots: { a: protoBot({ avatar: 'https://x/y.png' }) },
    });
    assert.equal(out[0].avatar, 'https://x/y.png');
  });

  it('fl/gl 非空时不重复拉取', async () => {
    let friendCalls = 0;
    const out = await collectBotInventory({
      bots: {
        a: protoBot({
          fl: { size: 5 },
          gl: { size: 2 },
          getFriendMap: async () => {
            friendCalls++;
            return new Map();
          },
        }),
      },
    });
    assert.equal(friendCalls, 0);
    assert.deepEqual(out[0].stats, { friends: 5, groups: 2 });
  });

  it('fl/gl 缺失时先拉取再统计', async () => {
    const out = await collectBotInventory({
      bots: {
        a: protoBot({
          // 真实 protocol bot 的 getFriendMap 自身把结果缓存回 bot.fl；
          // ensureBotFlGl 只负责「触发拉取」，不接收返回值。
          getFriendMap: async function () {
            this.fl = new Map([['1', {}], ['2', {}]]);
            return this.fl;
          },
          getGroupMap: async function () {
            this.gl = new Map([['g', {}]]);
            return this.gl;
          },
        }),
      },
    });
    assert.deepEqual(out[0].stats, { friends: 2, groups: 1 });
  });

  it('拉取抛错不中断（好友接口挂了仍要出列表）', async () => {
    const out = await collectBotInventory({
      bots: {
        a: protoBot({
          getFriendMap: async () => {
            throw new Error('boom');
          },
          getGroupMap: async () => {
            throw new Error('boom too');
          },
        }),
      },
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].stats, { friends: 0, groups: 0 });
  });

  it('无 getGroupMap 时可选链兜住（不抛）', async () => {
    const out = await collectBotInventory({
      bots: {
        a: {
          nickname: 'n',
          getFriendMap: async function () {
            this.fl = new Map([['1', {}]]);
            return this.fl;
          },
        },
      },
    });
    assert.deepEqual(out[0].stats, { friends: 1, groups: 0 });
  });
});

describe('collectBotInventory · 排序', () => {
  it('协议 bot 在前、设备 bot 在后', async () => {
    const out = await collectBotInventory({
      bots: {
        dev: { device_type: 'web' },
        proto: protoBot(),
      },
    });
    assert.deepEqual(out.map((b) => b.uin), ['proto', 'dev']);
  });

  it('同组内在线的排前', async () => {
    const out = await collectBotInventory({
      bots: {
        off: protoBot({ stat: { online: false } }),
        on: protoBot({ stat: { online: true } }),
      },
    });
    assert.deepEqual(out.map((b) => b.uin), ['on', 'off']);
  });

  it('三级排序同时生效：proto-on → proto-off → device-on', async () => {
    const out = await collectBotInventory({
      bots: {
        dev: { device_type: 'web' },
        poff: protoBot({ stat: { online: false } }),
        pon: protoBot({ stat: { online: true } }),
      },
    });
    assert.deepEqual(out.map((b) => b.uin), ['pon', 'poff', 'dev']);
  });

  it('includeDevices 选项当前不改变行为（参数保留位）', async () => {
    const bots = { dev: { device_type: 'web' }, proto: protoBot() };
    const withDev = await collectBotInventory({ bots }, { includeDevices: true });
    const withoutDev = await collectBotInventory({ bots }, { includeDevices: false });
    assert.deepEqual(withDev, withoutDev);
  });
});

describe('summarizeBots', () => {
  it('空输入 → 全零', () => {
    assert.deepEqual(summarizeBots(), { total: 0, devices: 0, online: 0, offline: 0 });
    assert.deepEqual(summarizeBots([]), { total: 0, devices: 0, online: 0, offline: 0 });
  });

  it('分别统计设备数 / 在线 / 离线', () => {
    const out = summarizeBots([
      { uin: '1', device: true, online: true, nickname: 'n', tasker: 't', stats: { friends: 0, groups: 0 } },
      { uin: '2', device: false, online: true, nickname: 'n', tasker: 't', stats: { friends: 0, groups: 0 } },
      { uin: '3', device: false, online: false, nickname: 'n', tasker: 't', stats: { friends: 0, groups: 0 } },
    ]);
    assert.deepEqual(out, { total: 3, devices: 1, online: 2, offline: 1 });
  });

  it('在线 + 离线恒等于总数（设备也计入）', () => {
    const bots = [
      { uin: '1', device: true, online: true, nickname: 'n', tasker: 't', stats: { friends: 0, groups: 0 } },
      { uin: '2', device: true, online: false, nickname: 'n', tasker: 't', stats: { friends: 0, groups: 0 } },
    ];
    const s = summarizeBots(bots);
    assert.equal(s.online + s.offline, s.total);
  });
});

describe('collectBotInventory → summarizeBots 闭环', () => {
  it('真实混合场景统计自洽', async () => {
    const list = await collectBotInventory({
      bots: {
        device_web: { device_type: 'web', online: true, nickname: 'Web' },
        device_and: { device_type: 'android', online: false },
        q_online: protoBot({ stat: { online: true }, fl: { size: 3 }, gl: { size: 1 } }),
        q_offline: protoBot({ stat: { online: false } }),
        junk: {},
        port: { nickname: 'n', tasker: { name: 't' } },
      },
    });
    const s = summarizeBots(list);
    assert.equal(s.total, 4);
    assert.equal(s.devices, 2);
    assert.equal(s.online, 2);
    assert.equal(s.offline, 2);
    assert.equal(list[0].stats.friends, 3);
  });
});
