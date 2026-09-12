/** HttpApiLoader 校验用的最小 API 面（与 HttpApi 字段对齐，不绑类） */
export type ApiLike = {
  name?: string;
  dsc?: string;
  priority?: number;
  enable?: boolean;
  routes?: unknown[];
};

export function getApiPriority(api: Pick<ApiLike, 'priority'> | { priority?: unknown }): number {
  const priority = Number(api.priority);
  return Number.isFinite(priority) ? priority : 100;
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
