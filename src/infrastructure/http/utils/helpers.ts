type ApiLike = {
  name?: string;
  dsc?: string;
  priority?: number;
  enable?: boolean;
  routes?: unknown[];
};

export function getApiPriority(api: { priority?: unknown }): number {
  const priority = Number(api.priority);
  return Number.isFinite(priority) ? priority : 100;
}

export function validateApiInstance(api: ApiLike, key: string): true {
  if (!api.name) api.name = key;
  if (!api.dsc) api.dsc = '';
  api.priority = getApiPriority(api);
  if (api.enable === undefined) api.enable = true;
  if (!Array.isArray(api.routes)) api.routes = [];
  return true;
}
