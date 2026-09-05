const EXCLUDE_KEYS = new Set(['port', 'apiKey', 'stdin', 'logger', '_eventsCount', 'url']);

type BotLike = {
  device_type?: string;
  getFriendMap?: () => Promise<unknown>;
  getGroupMap?: () => Promise<unknown>;
  fl?: { size?: number };
  gl?: { size?: number };
  online?: boolean;
  nickname?: string;
  info?: { device_name?: string };
  tasker?: { name?: string };
  avatar?: string | null;
  uin?: string | number;
  stat?: { online?: boolean };
  _ready?: boolean;
};

type AgentRuntimeLike = {
  bots?: Record<string, BotLike | null | undefined>;
};

export type BotInventoryItem = {
  uin: string;
  device: boolean;
  online: boolean;
  nickname: string;
  tasker: string;
  avatar?: string | null;
  stats: { friends: number; groups: number };
};

async function ensureBotFlGl(bot: BotLike): Promise<void> {
  if (bot.device_type || typeof bot.getFriendMap !== 'function') return;
  const needFl = !bot.fl || bot.fl.size === 0;
  const needGl = !bot.gl || bot.gl.size === 0;
  if (!needFl && !needGl) return;
  try {
    if (needFl) await bot.getFriendMap();
  } catch {
    /* ignore */
  }
  try {
    if (needGl) await bot.getGroupMap?.();
  } catch {
    /* ignore */
  }
}

export async function collectBotInventory(
  AgentRuntime: AgentRuntimeLike | null | undefined,
  { includeDevices: _includeDevices = true }: { includeDevices?: boolean } = {},
): Promise<BotInventoryItem[]> {
  if (!AgentRuntime?.bots) return [];
  const list: BotInventoryItem[] = [];
  const entries = Object.entries(AgentRuntime.bots);
  for (const [uin, bot] of entries) {
    if (!bot || typeof bot !== 'object' || EXCLUDE_KEYS.has(uin)) continue;

    if (bot.device_type) {
      list.push({
        uin,
        device: true,
        online: bot.online !== false,
        nickname: bot.nickname || bot.info?.device_name || '设备',
        tasker: bot.device_type === 'web' ? 'Web客户端' : bot.device_type || 'device',
        stats: { friends: 0, groups: 0 },
      });
      continue;
    }

    if (!bot.tasker && !bot.nickname && !bot.fl && !bot.gl) continue;

    await ensureBotFlGl(bot);

    const online = Boolean(bot.stat?.online ?? bot._ready);
    list.push({
      uin,
      device: false,
      online,
      nickname: bot.nickname || uin,
      tasker: bot.tasker?.name || 'unknown',
      avatar:
        bot.avatar ||
        (bot.uin && bot.tasker?.name === 'OneBotv11'
          ? `https://q1.qlogo.cn/g?b=qq&nk=${bot.uin}&s=100`
          : null),
      stats: { friends: bot.fl?.size ?? 0, groups: bot.gl?.size ?? 0 },
    });
  }
  return list.sort((a, b) =>
    a.device !== b.device ? (a.device ? 1 : -1) : Number(b.online) - Number(a.online),
  );
}

export function summarizeBots(bots: BotInventoryItem[] = []): {
  total: number;
  devices: number;
  online: number;
  offline: number;
} {
  const summary = {
    total: bots.length,
    devices: 0,
    online: 0,
    offline: 0,
  };

  for (const bot of bots) {
    if (bot.device) summary.devices++;
    if (bot.online) summary.online++;
    else summary.offline++;
  }

  return summary;
}
