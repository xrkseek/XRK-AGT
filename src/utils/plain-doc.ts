/** 配置 / 选项对象最小面；避免 `x || {}` 被推断为字面量 `{}` 导致 TS2339 */
export type PlainDoc = Record<string, any>;

export const EMPTY_DOC: PlainDoc = Object.freeze({}) as PlainDoc;

export function asPlainDoc(value: unknown): PlainDoc {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as PlainDoc)
    : EMPTY_DOC;
}
