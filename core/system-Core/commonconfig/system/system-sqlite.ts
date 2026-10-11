import { getConfigPath } from './system-schema-helpers.js';

/**
 * Runtime SQLite（node:sqlite）CommonConfig schema
 * 模板：config/default_config/sqlite.yaml
 */
export const sqliteConfig = {
  name: 'sqlite',
  displayName: 'SQLite 配置',
  description: 'Runtime 嵌入式 SQLite（Node 内置 node:sqlite），与 Redis 同级初始化',
  filePath: getConfigPath('sqlite'),
  fileType: 'yaml',
  schema: {
    required: ['enabled', 'filePath'],
    fields: {
      enabled: {
        type: 'boolean',
        label: '启用',
        description: '关闭后 DatabaseManager 启动会失败（Runtime 硬依赖）',
        default: true,
        component: 'Switch',
      },
      filePath: {
        type: 'string',
        label: '数据库文件路径',
        description: '相对项目根或绝对路径；":memory:" 表示内存库',
        default: 'data/runtime/xrk_agt.db',
        component: 'Input',
      },
      memory: {
        type: 'boolean',
        label: '内存模式',
        description: '为 true 时使用 :memory:，忽略 filePath（适合测试）',
        default: false,
        component: 'Switch',
      },
      walMode: {
        type: 'boolean',
        label: 'WAL 模式',
        description: '磁盘库启用 PRAGMA journal_mode=WAL，提升并发读',
        default: true,
        component: 'Switch',
      },
      busyTimeoutMs: {
        type: 'number',
        label: '锁等待（毫秒）',
        description: 'DatabaseSync busy timeout，写冲突时等待时长',
        min: 0,
        default: 5000,
        component: 'InputNumber',
      },
      foreignKeys: {
        type: 'boolean',
        label: '外键约束',
        description: '启用 PRAGMA foreign_keys 与打开时的 FK 检查',
        default: true,
        component: 'Switch',
      },
    },
  },
};
