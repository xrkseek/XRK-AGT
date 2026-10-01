/** HttpApiLoader 校验用的最小 API 面（与 HttpApi 字段对齐，不绑类） */
export type ApiLike = {
  name?: string;
  dsc?: string;
  priority?: number;
  enable?: boolean;
  routes?: unknown[];
  wsHandlers?: Record<string, unknown>;
};

export function getApiPriority(api: Pick<ApiLike, 'priority'> | { priority?: unknown }): number {
  const priority = Number(api.priority);
  return Number.isFinite(priority) ? priority : 100;
}

/** API 自述信息：注册表与 Loader 消费的统一形状 */
export type ApiInfo = {
  name: string
  dsc: string
  priority: number
  routes: number
  ws?: number
  enable: boolean
  createTime: number
}

/**
 * getInfo 的唯一实现。HttpApi.getInfo() 与 HttpApiLoader 的兜底实现共用本函数，
 * 避免两处各自维护一份字段清单（此前 loader 侧漏了 ws，且 enable/priority 取法不同）。
 */
export function defaultApiInfo(api: ApiLike, createTime: number = Date.now()): ApiInfo {
  return {
    name: api.name ?? '',
    dsc: api.dsc ?? '',
    priority: getApiPriority(api),
    routes: Array.isArray(api.routes) ? api.routes.length : 0,
    ws: api.wsHandlers ? Object.keys(api.wsHandlers).length : 0,
    enable: api.enable !== false,
    createTime,
  }
}

/** 就地补齐 name/dsc/priority/enable/routes，返回 true 表示可注册 */
export function validateApiInstance(api: ApiLike, key: string): true {
  if (!api.name) api.name = key;
  if (!api.dsc) api.dsc = '';
  api.priority = getApiPriority(api);
  if (api.enable === undefined) api.enable = true;
  if (!Array.isArray(api.routes)) api.routes = [];
  return true;
}
