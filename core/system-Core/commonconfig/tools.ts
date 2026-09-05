// @ts-nocheck
import ConfigBase from '#infrastructure/commonconfig/commonconfig.js';

/**
 * 工具配置 — config/cmd/tools.yaml（终端指令 / 内联 JS）
 */
export default class ToolsConfig extends ConfigBase {
  constructor() {
    super({
      name: 'tools',
      displayName: '工具配置',
      description: '终端指令与内联 JS 执行：权限、超时、输出与沙箱',
      filePath: 'config/cmd/tools.yaml',
      fileType: 'yaml',
      schema: {
        fields: {
          permission: {
            type: 'string',
            label: '权限控制',
            description: 'master=仅主人；admin=主人+管理员；all=所有人（线上慎开）',
            enum: ['master', 'admin', 'all'],
            default: 'master',
            component: 'Select',
            group: '权限',
          },
          blacklist: {
            type: 'boolean',
            label: '启用黑名单',
            description: '是否按下方关键词拦截危险命令',
            default: true,
            component: 'Switch',
            group: '权限',
          },
          ban: {
            type: 'array',
            label: '禁止执行的命令',
            description: '命中即拒绝（子串匹配）',
            itemType: 'string',
            default: ['rm -rf', 'sudo', 'shutdown', 'reboot'],
            component: 'Tags',
            group: '权限',
          },
          shell: {
            type: 'boolean',
            label: '使用系统 Shell',
            description: 'true=经 shell 解析管道/重定向；false=直接 spawn',
            default: true,
            component: 'Switch',
            group: '执行',
          },
          timeout: {
            type: 'number',
            label: '命令超时(ms)',
            description: '超时杀进程',
            min: 1000,
            default: 300000,
            component: 'InputNumber',
            group: '执行',
          },
          updateInterval: {
            type: 'number',
            label: '进度更新间隔(ms)',
            description: '长命令向聊天推送进度的间隔',
            min: 100,
            default: 3000,
            component: 'InputNumber',
            group: '执行',
          },
          maxOutputLength: {
            type: 'number',
            label: '最大输出长度',
            description: '单次回传聊天的最大字符数',
            min: 100,
            default: 5000,
            component: 'InputNumber',
            group: '输出',
          },
          saveChunkedOutput: {
            type: 'boolean',
            label: '保存分块输出',
            description: '分块推送时缓存片段便于合并',
            default: true,
            component: 'Switch',
            group: '输出',
          },
          maxHistory: {
            type: 'number',
            label: '历史条数上限',
            description: '保留的命令执行历史条数',
            min: 1,
            default: 100,
            component: 'InputNumber',
            group: '输出',
          },
          maxObjectDepth: {
            type: 'number',
            label: '对象打印深度',
            description: '结构化打印时的递归深度',
            min: 1,
            default: 4,
            component: 'InputNumber',
            group: '输出',
          },
          circularDetection: {
            type: 'boolean',
            label: '检测循环引用',
            description: '打印对象时检测环，避免死循环',
            default: true,
            component: 'Switch',
            group: '输出',
          },
          printMode: {
            type: 'string',
            label: '打印模式',
            description: 'full=结构化；simple=纯字符串（长日志）',
            enum: ['full', 'simple'],
            default: 'full',
            component: 'Select',
            group: '输出',
          },
          jsExecutionMode: {
            type: 'string',
            label: 'JS 执行模式',
            description: 'safe=沙箱；unsafe=完整 Node 权限（仅信任环境）',
            enum: ['safe', 'unsafe'],
            default: 'safe',
            component: 'Select',
            group: 'JS',
          },
          jsTimeout: {
            type: 'number',
            label: 'JS 执行超时(ms)',
            description: '内联 JS 最长执行时间',
            min: 1000,
            default: 10000,
            component: 'InputNumber',
            group: 'JS',
          },
        },
      },
    });
  }
}
