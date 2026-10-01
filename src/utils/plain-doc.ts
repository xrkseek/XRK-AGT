/** 配置 / 选项对象最小面；避免 `x || {}` 被推断为字面量 `{}` 导致 TS2339 */
export type PlainDoc = Record<string, any>;

export const EMPTY_DOC: PlainDoc = Object.freeze({}) as PlainDoc;

export function asPlainDoc(value: unknown): PlainDoc {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as PlainDoc)
    : EMPTY_DOC;
}

/**
 * yaml 节点降级为可索引对象，**返回未冻结的新对象**。
 *
 * 与 asPlainDoc 的区别仅在冻结：调用方仍会把结果放进可写容器
 * （如 `this.config[key]`），若换成冻结对象，后续写入会在 strict mode 抛错。
 * 新代码优先用 asPlainDoc；此处为兼容既有 config 装配路径保留。
 */
export function asYamlDoc(value: unknown): PlainDoc {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as PlainDoc)
    : {};
}
