/**
 * 配置扁平路径工具（对齐原 config-manager.js）
 */

import { deepClone } from '@/utils/http';

export function getNestedValue(obj = {}, path = '') {
  if (!path) return obj;
  return path.split('.').reduce((cur, key) => (cur != null ? cur[key] : undefined), obj);
}

export function castFieldValue(value, type, component) {
  const t = String(type || '').toLowerCase();
  const c = String(component || '').toLowerCase();
  if (t === 'number' || c === 'inputnumber' || c === 'number' || c === 'slider' || c === 'range') {
    if (value === '' || value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (t === 'boolean' || c === 'switch') {
    if (typeof value === 'string') {
      const s = value.toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'off'].includes(s)) return false;
    }
    return Boolean(value);
  }
  if (t === 'array<object>' || c === 'arrayform') {
    return Array.isArray(value) ? value : [];
  }
  if (t === 'array' || c === 'tags' || c === 'multiselect') {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      return value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
    return [];
  }
  if (t === 'object' || t === 'map' || c === 'json' || c === 'subform' || c === 'keyedobject' || c === 'keyed') {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return {};
      }
    }
    return {};
  }
  return value;
}

/** 规范化后端 flat-structure 为可渲染字段列表 */
export function normalizeFlatFields(flat) {
  if (!flat) return [];
  let list = [];
  if (Array.isArray(flat)) list = flat.map(normalizeOneField).filter(Boolean);
  else if (typeof flat === 'object') {
    if (Array.isArray(flat.fields)) list = flat.fields.map(normalizeOneField).filter(Boolean);
    else {
      list = Object.entries(flat)
        .map(([path, schema]) => normalizeOneField({ ...(schema || {}), path: schema?.path || path }))
        .filter(Boolean);
    }
  }

  const paths = list.map((f) => f.path);
  /** @type {Map<string, { label: string, description: string }>} */
  const containers = new Map();

  for (const f of list) {
    const isObjLike =
      f.type === 'object' ||
      f.type === 'map' ||
      f.component === 'subform' ||
      f.component === 'json';
    if (!isObjLike) continue;
    const hasChildren = paths.some((p) => p.startsWith(`${f.path}.`) && !p.includes('[]'));
    // API 已标 container，或本地检测有子路径 → 分组壳，不进表单编辑
    if (f.container || hasChildren) {
      f.container = true;
      containers.set(f.path, { label: f.label, description: f.description });
    }
  }

  // 子字段归入最近「深层」容器（最长 path），保留 Brave / Perplexity 等 SubForm 身份；
  // 若取浅层，同名 apiKey/baseUrl 会堆进同一组，表单上看不出归属。
  for (const f of list) {
    if (f.container) continue;
    let best = '';
    for (const cpath of containers.keys()) {
      if (!f.path.startsWith(`${cpath}.`)) continue;
      if (!best || cpath.length > best.length) best = cpath;
    }
    if (!best) continue;
    const info = containers.get(best);
    // 仅覆盖默认「基础」；显式 meta.group 保留
    if (!f.group || f.group === '基础') {
      f.group = info?.label || best.split('.').pop() || best;
    }
    if (!f.groupDesc && info?.description) f.groupDesc = info.description;
  }

  return list.filter((f) => !f.container);
}

function normalizeOneField(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const path = raw.path || raw.key || raw.name || meta.path;
  if (!path) return null;
  // 模板路径（providers[].model）仅服务 ArrayForm，首轮表单跳过
  if (String(path).includes('[]')) return null;
  const type = raw.type || meta.type || 'string';
  const component = String(
    raw.component || meta.component || mapTypeToComponent(type) || 'input',
  ).toLowerCase();
  const itemSchema = meta.itemSchema || raw.itemSchema || null;
  const fieldsRaw = itemSchema?.fields || meta.fields || raw.fields || null;
  const fields =
    fieldsRaw && typeof fieldsRaw === 'object' && !Array.isArray(fieldsRaw) ? fieldsRaw : null;
  const container = Boolean(raw.container ?? meta.container);
  return {
    path,
    type,
    component,
    container,
    fields,
    label: meta.label || meta.title || raw.label || raw.title || path.split('.').pop(),
    description: meta.description || meta.desc || raw.description || raw.desc || '',
    required: Boolean(meta.required ?? raw.required),
    options: normalizeOptions(meta.options || meta.enum || meta.choices || raw.options || raw.enum),
    group: meta.group || meta.section || raw.group || '基础',
    groupDesc: meta.groupDesc || raw.groupDesc || '',
    default: Object.prototype.hasOwnProperty.call(meta, 'default')
      ? meta.default
      : raw.default,
    min: meta.min ?? raw.min,
    max: meta.max ?? raw.max,
    step: meta.step ?? raw.step,
    placeholder: meta.placeholder || raw.placeholder || '',
    sensitive: Boolean(meta.sensitive || component === 'inputpassword'),
    layout: meta.layout || raw.layout,
    span: meta.span || raw.span,
    example: Object.prototype.hasOwnProperty.call(meta, 'example')
      ? meta.example
      : raw.example,
    itemLabel: meta.itemLabel || raw.itemLabel || '条目',
    // 与 fields 同源；数组项 schema 仍读 itemFields
    itemFields: fields,
    keyLabel: meta.keyLabel || raw.keyLabel || '',
    keyPlaceholder: meta.keyPlaceholder || raw.keyPlaceholder || '',
    // 虚拟 path（如 groupOverrides）：读写根级动态键，不写进 YAML 该 path 本身
    keyedSiblings: Boolean(meta.keyedSiblings ?? raw.keyedSiblings),
    excludeKeys: Array.isArray(meta.excludeKeys)
      ? meta.excludeKeys
      : Array.isArray(raw.excludeKeys)
        ? raw.excludeKeys
        : [],
  };
}

/** 从 /structure 取当前配置的 schema 根（system / llm_factories 等多文件走 configs[child]） */
export function extractActiveSchema(structure, name, child) {
  if (!structure) return null;
  if (structure.configs && typeof structure.configs === 'object') {
    if (!child) return null;
    const target = structure.configs[child];
    return target?.schema ?? { fields: target?.fields ?? {} };
  }
  return structure.schema ?? { fields: structure.fields ?? {} };
}

/** 扫描 schema，得到 path → 数组项 fields（对齐原 buildArraySchemaIndex） */
export function buildArraySchemaIndex(schema, prefix = '', map = {}) {
  if (!schema || !schema.fields) return map;
  for (const [key, fieldSchema] of Object.entries(schema.fields)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (fieldSchema.type === 'array' && fieldSchema.itemType === 'object') {
      map[path] = fieldSchema.itemSchema?.fields ?? fieldSchema.fields ?? {};
    }
    if ((fieldSchema.type === 'object' || fieldSchema.type === 'map') && fieldSchema.fields) {
      buildArraySchemaIndex(fieldSchema, path, map);
    }
  }
  return map;
}

/** 从 flat-structure 的 providers[].x 模板路径补全 arraySchemas */
export function arraySchemasFromFlatTemplates(flat) {
  const map = {};
  const list = Array.isArray(flat) ? flat : Array.isArray(flat?.fields) ? flat.fields : [];
  for (const raw of list) {
    const path = raw?.path || raw?.meta?.path;
    if (!path || !String(path).includes('[]')) continue;
    const m = String(path).match(/^(.*)\[\](?:\.(.+))?$/);
    if (!m) continue;
    const parent = m[1];
    const rel = m[2];
    if (!map[parent]) map[parent] = {};
    if (!rel) continue;
    const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
    const node = {
      type: raw.type || meta.type || 'string',
      label: meta.label || raw.label || rel.split('.').pop(),
      description: meta.description || raw.description || '',
      component: raw.component || meta.component,
      default: Object.prototype.hasOwnProperty.call(meta, 'default') ? meta.default : raw.default,
      enum: meta.enum || meta.options || raw.enum,
      options: meta.options || meta.enum,
      min: meta.min ?? raw.min,
      max: meta.max ?? raw.max,
      step: meta.step ?? raw.step,
      placeholder: meta.placeholder || raw.placeholder || '',
      fields: meta.fields || raw.fields,
      layout: meta.layout || raw.layout,
      span: meta.span || raw.span,
    };
    setNestedSchemaField(map[parent], rel, node);
  }
  return map;
}

function setNestedSchemaField(root, relPath, node) {
  const parts = String(relPath).split('.');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (i === parts.length - 1) {
      cur[key] = { ...(cur[key] || {}), ...node };
      return;
    }
    if (!cur[key] || typeof cur[key] !== 'object') {
      cur[key] = { type: 'object', fields: {} };
    }
    if (!cur[key].fields) cur[key].fields = {};
    cur = cur[key].fields;
  }
}

export function setNestedValue(source = {}, path = '', value) {
  if (!path) return deepClone(value);
  const clone = Array.isArray(source) ? [...source] : { ...source };
  const keys = path.split('.');
  let cursor = clone;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (i === keys.length - 1) {
      cursor[key] = deepClone(value);
    } else {
      const next = cursor[key];
      const blank = /^\d+$/.test(keys[i + 1]) ? [] : {};
      cursor[key] =
        next && typeof next === 'object' ? (Array.isArray(next) ? [...next] : { ...next }) : blank;
      cursor = cursor[key];
    }
  }
  return clone;
}

/** 按 itemSchema 生成新增条目默认值（缺省按类型补全） */
export function buildDefaultsFromFields(fields = {}) {
  const result = {};
  for (const [key, schema] of Object.entries(fields || {})) {
    if (!schema || typeof schema !== 'object') continue;
    if (schema.type === 'object' && schema.fields) {
      result[key] = buildDefaultsFromFields(schema.fields);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'default')) {
      result[key] = deepClone(schema.default);
      continue;
    }
    const ctrl = resolveFieldControl(schema);
    if (ctrl === 'switch') result[key] = false;
    else if (ctrl === 'number') result[key] = null;
    else if (ctrl === 'tags' || ctrl === 'array') result[key] = [];
    else if (ctrl === 'json' || ctrl === 'kv' || ctrl === 'nested') result[key] = {};
    else if (schema.type === 'array') result[key] = [];
    else result[key] = '';
  }
  return result;
}

export function resolveArrayItemFields(path, arraySchemas = {}, field = null) {
  if (arraySchemas?.[path] && Object.keys(arraySchemas[path]).length) {
    return arraySchemas[path];
  }
  if (field?.itemFields && Object.keys(field.itemFields).length) return field.itemFields;
  return {};
}

function mapTypeToComponent(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'boolean') return 'switch';
  if (t === 'number') return 'number';
  if (t === 'array<object>') return 'arrayform';
  if (t === 'array') return 'tags';
  if (t === 'map') return 'keyedobject';
  if (t === 'object') return 'json';
  if (t.includes('password')) return 'inputpassword';
  return 'input';
}

/**
 * 从 example / 现有值推断「动态键 → 对象」的值字段模板
 * @param {unknown} sample
 * @returns {Record<string, object>|null}
 */
export function inferFieldsFromExample(sample) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null;
  const values = Object.values(sample);
  const firstObj = values.find((v) => v && typeof v === 'object' && !Array.isArray(v));
  if (!firstObj) return null;
  /** @type {Record<string, object>} */
  const fields = {};
  for (const [k, v] of Object.entries(firstObj)) {
    if (typeof v === 'boolean') {
      fields[k] = { type: 'boolean', label: k, component: 'Switch', default: v };
    } else if (typeof v === 'number') {
      fields[k] = { type: 'number', label: k, component: 'InputNumber', default: v };
    } else if (Array.isArray(v)) {
      fields[k] = {
        type: 'array',
        label: k,
        component: 'Tags',
        itemType: 'string',
        default: [...v],
      };
    } else if (v && typeof v === 'object') {
      fields[k] = { type: 'object', label: k, component: 'json', default: deepClone(v) };
    } else {
      fields[k] = { type: 'string', label: k, default: v == null ? '' : String(v) };
    }
  }
  return Object.keys(fields).length ? fields : null;
}

/**
 * 从扁平 path 字典还原 object/map 整值（兼容 flattenData 拆开的 path.key.sub）
 * @param {Record<string, any>} flat
 * @param {string} path
 */
export function collectObjectFromFlat(flat, path) {
  const src = flat && typeof flat === 'object' ? flat : {};
  if (Object.prototype.hasOwnProperty.call(src, path)) {
    const v = src[path];
    if (v && typeof v === 'object') return deepClone(v);
  }
  const prefix = `${path}.`;
  /** @type {Record<string, any>} */
  const acc = {};
  let hit = false;
  for (const [p, v] of Object.entries(src)) {
    if (!p.startsWith(prefix)) continue;
    hit = true;
    const rel = p.slice(prefix.length);
    if (!rel) continue;
    const parts = rel.split('.');
    let cur = acc;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i];
      if (i === parts.length - 1) {
        cur[key] = deepClone(v);
      } else {
        if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
        cur = cur[key];
      }
    }
  }
  return hit ? acc : {};
}

/**
 * chatbot 根级群号覆盖：从 flat 收集「非 excludeKeys」的顶层键 → 对象
 * （如 chatbot 根级 123456.xxx，排除 master/default 等固定键）
 * @param {Record<string, any>} flat
 * @param {string[]} excludeKeys
 */
export function collectKeyedSiblingsFromFlat(flat, excludeKeys = []) {
  const src = flat && typeof flat === 'object' ? flat : {};
  const exclude = new Set((excludeKeys || []).map(String));
  const tops = new Set();
  for (const p of Object.keys(src)) {
    const top = String(p).split('.')[0];
    if (!top || exclude.has(top)) continue;
    tops.add(top);
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of tops) {
    out[k] = collectObjectFromFlat(src, k);
  }
  return out;
}

const FULL_COMPONENTS = new Set([
  'textarea',
  'text-area',
  'arrayform',
  'subform',
  'inputpassword',
  'json',
  'keyedobject',
]);

const FULL_KEY_PATTERN =
  /^(wsUrl|baseUrl|path|instructions|promptCacheKey|safetyIdentifier|anthropicVersion|apiVersion|deployment|headers|extraBody|proxy|description|content|.*[Uu]rl)$/;

/**
 * 统一字段控件类型（ConfigView / ConfigArrayForm / 嵌套子表共用）
 * @returns {'switch'|'select'|'multiselect'|'tags'|'textarea'|'number'|'password'|'array'|'json'|'kv'|'nested'|'keyed'|'input'}
 */
export function resolveFieldControl(field = {}) {
  const c = String(field?.component || '').toLowerCase();
  const t = String(field?.type || '').toLowerCase();
  if (c === 'switch' || t === 'boolean') return 'switch';

  // 多选必须先于 hasChoiceOptions：否则带 enum 的 MultiSelect 会被误判成单选 Select
  if (c === 'multiselect') return 'multiselect';
  if (c === 'tags') return 'tags';
  if (t === 'array' && c !== 'arrayform') {
    return hasChoiceOptions(field) ? 'multiselect' : 'tags';
  }

  if (c === 'select' || c === 'radio' || hasChoiceOptions(field)) return 'select';
  if (c === 'textarea' || c === 'text-area') return 'textarea';
  if (c === 'number' || c === 'inputnumber' || c === 'slider' || c === 'range' || t === 'number') {
    return 'number';
  }
  if (c === 'inputpassword' || c === 'password') return 'password';
  if (c === 'arrayform' || t === 'array<object>') return 'array';
  if (c === 'kv') return 'kv';
  if (c === 'keyedobject' || c === 'keyed' || t === 'map') return 'keyed';
  if (c === 'json') {
    if (inferFieldsFromExample(field.example)) return 'keyed';
    return 'json';
  }

  const nestedFields = fieldNestedFields(field);
  const hasNested = Object.keys(nestedFields).length > 0;
  if (hasNested && (c === 'subform' || t === 'object')) {
    if (inferFieldsFromExample(field.example)) return 'keyed';
    return 'nested';
  }
  if (c === 'subform' || t === 'object') {
    if (inferFieldsFromExample(field.example)) return 'keyed';
    return 'json';
  }
  return 'input';
}

/** @param {object} field */
export function fieldNestedFields(field = {}) {
  const raw = field.fields || field.itemFields;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function hasChoiceOptions(field) {
  const opts = field?.enum || field?.options || field?.choices;
  if (!opts) return false;
  if (Array.isArray(opts)) return opts.length > 0;
  if (typeof opts === 'object') return Object.keys(opts).length > 0;
  return false;
}

/**
 * 半宽进网格；全宽占满一行。
 * 字符串 Tags 与 Input/Select 同级，不强制整行。
 */
export function isFieldFullSpan(field) {
  if (!field) return true;
  const meta = field;
  if (meta.layout === 'full' || meta.span === 'full') return true;
  if (meta.layout === 'half' || meta.span === 'half') return false;

  const component = String(meta.component || '').toLowerCase();
  const type = String(meta.type || '').toLowerCase();
  const path = String(meta.path || '');
  const key = path.split('.').pop() || path;
  const ctrl = resolveFieldControl(meta);

  if (ctrl === 'tags') return false;
  if (FULL_COMPONENTS.has(component)) return true;
  if (
    ctrl === 'textarea'
    || ctrl === 'array'
    || ctrl === 'json'
    || ctrl === 'kv'
    || ctrl === 'nested'
    || ctrl === 'keyed'
    || ctrl === 'multiselect'
  ) {
    return true;
  }
  if (type === 'object' || type === 'map' || type === 'array<object>') {
    return true;
  }
  if (FULL_KEY_PATTERN.test(key)) return true;
  return false;
}

/** ArrayForm / KeyedMapForm：条目内子字段是否全宽 */
export function isConfigEntryFieldFull(key, schema) {
  return isFieldFullSpan({
    path: key,
    type: schema?.type || 'string',
    component: String(schema?.component || '').toLowerCase(),
    layout: schema?.layout,
    span: schema?.span,
    fields: schema?.fields,
  });
}

export function normalizeOptions(opts) {
  if (!opts) return [];
  if (Array.isArray(opts)) {
    return opts.map((o) => {
      if (o && typeof o === 'object') {
        return { label: o.label ?? o.name ?? String(o.value), value: o.value ?? o.key ?? o.name };
      }
      return { label: String(o), value: o };
    });
  }
  if (typeof opts === 'object') {
    return Object.entries(opts).map(([value, label]) => ({ value, label: String(label) }));
  }
  return [];
}

/** Tags 控件：数组 ↔ 逗号分隔文本 */
export function formatTagsText(value) {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

export function parseTagsText(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 按 schema 规范化 object（含嵌套）；未知键保留，避免丢自定义字段。
 */
export function canonicalizeObjectByFields(obj, fields = {}) {
  const src = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const out = {};
  for (const [key, schema] of Object.entries(fields || {})) {
    if (!schema || typeof schema !== 'object') continue;
    if ((schema.type === 'object' || schema.component === 'subform') && schema.fields) {
      out[key] = canonicalizeObjectByFields(src[key], schema.fields);
      continue;
    }
    out[key] = canonicalizeFieldValue(src[key], schema.type, schema.component);
  }
  for (const [key, val] of Object.entries(src)) {
    if (!(key in out)) out[key] = deepClone(val);
  }
  return out;
}

export function canonicalizeArrayObjectValue(value, itemFields = {}) {
  const arr = Array.isArray(value) ? value : [];
  if (!itemFields || !Object.keys(itemFields).length) {
    return arr.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item) ? deepClone(item) : {},
    );
  }
  return arr.map((item) => canonicalizeObjectByFields(item, itemFields));
}

export function groupFields(fields) {
  const map = new Map();
  for (const f of fields) {
    const g = f.group || '基础';
    if (!map.has(g)) {
      map.set(g, { label: g, desc: f.groupDesc || '', items: [] });
    }
    const entry = map.get(g);
    if (!entry.desc && f.groupDesc) entry.desc = f.groupDesc;
    entry.items.push(f);
  }
  return [...map.values()];
}

export function formatGroupLabel(label) {
  if (!label || label === '基础') return '基础设置';
  return String(label).replace(/_/g, ' ');
}

export function formatExample(example) {
  if (example == null) return '';
  if (typeof example === 'string') return example;
  try {
    return JSON.stringify(example, null, 2);
  } catch {
    return String(example);
  }
}

/** 深度相等（对齐原 utils.isSameValue） */
export function isSameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => isSameValue(item, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => isSameValue(a[key], b[key]));
}

/**
 * 表单控件会改写类型（string↔number、null↔''）。
 * 比较 / 落盘前统一成 schema 类型，避免「未改也显示待保存」。
 */
export function canonicalizeFieldValue(value, type, component) {
  const c = String(component || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  const v = castFieldValue(value, type, component);
  if (t === 'number' || c === 'inputnumber' || c === 'number' || c === 'slider' || c === 'range') {
    if (v === '' || v === undefined) return null;
    return v;
  }
  if (t === 'boolean' || c === 'switch') return Boolean(v);
  if (
    t === 'array' ||
    t === 'array<object>' ||
    c === 'tags' ||
    c === 'multiselect' ||
    c === 'arrayform'
  ) {
    return Array.isArray(v) ? v : [];
  }
  if (t === 'object' || t === 'map' || c === 'json' || c === 'subform' || c === 'keyedobject' || c === 'keyed') {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }
  if (v == null) return '';
  return v;
}

export function sameFieldValue(a, b, type, component) {
  return isSameValue(
    canonicalizeFieldValue(a, type, component),
    canonicalizeFieldValue(b, type, component),
  );
}

/**
 * @param {Record<string, any>} values
 * @param {Record<string, any>} original
 * @param {any[]} fields
 * @param {Record<string, object>} [arraySchemas]
 */
export function buildDirtyFlat(values, original, fields, arraySchemas = {}) {
  const flat = {};
  for (const f of fields) {
    // 虚拟 path → 展开为 YAML 根级群号键；删除用 null（batch-set 删路径）
    if (f.keyedSiblings) {
      const next = canonicalizeFieldValue(values[f.path], f.type, f.component) || {};
      const prev = canonicalizeFieldValue(original[f.path], f.type, f.component) || {};
      for (const [k, v] of Object.entries(next)) {
        if (!isSameValue(v, prev[k])) flat[k] = v;
      }
      for (const k of Object.keys(prev)) {
        if (!Object.prototype.hasOwnProperty.call(next, k)) flat[k] = null;
      }
      continue;
    }
    const isArrObj = f.type === 'array<object>' || f.component === 'arrayform';
    const itemFields = arraySchemas?.[f.path] || f.itemFields || {};
    const next = isArrObj
      ? canonicalizeArrayObjectValue(values[f.path], itemFields)
      : canonicalizeFieldValue(values[f.path], f.type, f.component);
    const prev = isArrObj
      ? canonicalizeArrayObjectValue(original[f.path], itemFields)
      : canonicalizeFieldValue(original[f.path], f.type, f.component);
    if (!isSameValue(next, prev)) flat[f.path] = next;
  }
  return flat;
}

/** 将 path→value 的 JSON 对象落到 values；缺省 path 回落到 schema 默认 */
export function applyFlatJsonObject(parsed, fields) {
  const src = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return valuesFromFlat(src, fields);
}

export function valuesFromFlat(flat, fields) {
  const out = {};
  const src = flat && typeof flat === 'object' ? flat : {};
  for (const f of fields) {
    const isObjMap =
      f.type === 'object' ||
      f.type === 'map' ||
      f.component === 'json' ||
      f.component === 'subform' ||
      f.component === 'keyedobject' ||
      f.component === 'keyed';

    let raw;
    if (f.keyedSiblings) {
      const exact = Object.prototype.hasOwnProperty.call(src, f.path) ? src[f.path] : undefined;
      if (exact && typeof exact === 'object' && !Array.isArray(exact) && Object.keys(exact).length) {
        raw = deepClone(exact);
      } else {
        raw = collectKeyedSiblingsFromFlat(src, [...(f.excludeKeys || []), f.path]);
      }
    } else if (isObjMap) {
      const exact = Object.prototype.hasOwnProperty.call(src, f.path) ? src[f.path] : undefined;
      const collected = collectObjectFromFlat(src, f.path);
      if (exact && typeof exact === 'object' && !Array.isArray(exact) && Object.keys(exact).length) {
        raw = deepClone(exact);
      } else if (Object.keys(collected).length) {
        raw = collected;
      } else if (exact && typeof exact === 'object') {
        raw = deepClone(exact);
      } else if (Object.prototype.hasOwnProperty.call(f, 'default')) {
        raw = deepClone(f.default);
      } else {
        raw = {};
      }
    } else if (Object.prototype.hasOwnProperty.call(src, f.path)) {
      raw = deepClone(src[f.path]);
    } else if (Object.prototype.hasOwnProperty.call(f, 'default')) {
      raw = deepClone(f.default);
    } else if (f.component === 'switch') {
      raw = false;
    } else if (
      f.component === 'tags' ||
      f.component === 'multiselect' ||
      f.type === 'array<object>' ||
      f.component === 'arrayform'
    ) {
      raw = [];
    } else if (f.component === 'number' || f.component === 'inputnumber' || f.type === 'number') {
      raw = null;
    } else {
      raw = '';
    }
    out[f.path] = canonicalizeFieldValue(raw, f.type, f.component);
  }
  return out;
}
