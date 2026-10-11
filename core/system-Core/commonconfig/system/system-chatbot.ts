import { getConfigPath } from './system-schema-helpers.js';
import { CHATBOT_FIXED_ROOT_KEYS } from '#infrastructure/config/config-constants.js';

/**
 * 群默认 / 按群号覆盖共用字段。
 * loader-deal（冷却、插件启停）、OneBotEnhancer（@/别名）、add.js（词条与违禁词策略）
 */
const groupEntryFields = {
  groupGlobalCD: {
    type: 'number',
    label: '群全局冷却',
    description: '同群指令全局冷却（毫秒），0 不限制',
    min: 0,
    default: 500,
    component: 'InputNumber',
  },
  singleCD: {
    type: 'number',
    label: '单人冷却',
    description: '同群同人指令冷却（毫秒），0 不限制',
    min: 0,
    default: 500,
    component: 'InputNumber',
  },
  onlyReplyAt: {
    type: 'number',
    label: '仅 @ / 前缀响应',
    description: '0 不限制；1 需 @ 或别名前缀；2 同 1，主人免限',
    enum: [0, 1, 2],
    options: [
      { label: '0 · 不限制', value: 0 },
      { label: '1 · 需 @/前缀', value: 1 },
      { label: '2 · 非主人需 @/前缀', value: 2 },
    ],
    default: 0,
    component: 'Select',
  },
  botAlias: {
    type: 'array',
    label: '机器人别名',
    description: '匹配 @ 或消息前缀；空且 onlyReplyAt≠0 时不拦',
    itemType: 'string',
    default: [],
    component: 'Tags',
  },
  enable: {
    type: 'array',
    label: '插件白名单',
    description: '只跑列出的插件 name；空=全部',
    itemType: 'string',
    default: [],
    component: 'Tags',
  },
  disable: {
    type: 'array',
    label: '插件黑名单',
    description: '禁用的插件 name',
    itemType: 'string',
    default: [],
    component: 'Tags',
  },
  addPrivate: {
    type: 'number',
    label: '私聊可用添加指令',
    description: '1 允许私聊用 #添加 等；0 仅群内',
    enum: [0, 1],
    options: [
      { label: '0 · 仅群内', value: 0 },
      { label: '1 · 允许私聊', value: 1 },
    ],
    default: 1,
    component: 'Select',
  },
  addLimit: {
    type: 'number',
    label: '添加指令权限',
    description: '0 所有人；1 管理员；2 仅主人',
    enum: [0, 1, 2],
    options: [
      { label: '0 · 所有人', value: 0 },
      { label: '1 · 管理员', value: 1 },
      { label: '2 · 仅主人', value: 2 },
    ],
    default: 0,
    component: 'Select',
  },
  addReply: {
    type: 'boolean',
    label: '词条回复时引用',
    description: '命中添加词条后是否引用原消息',
    default: true,
    component: 'Switch',
  },
  addAt: {
    type: 'boolean',
    label: '词条回复时 @',
    description: '命中词条后是否 @ 触发者',
    default: false,
    component: 'Switch',
  },
  addRecall: {
    type: 'number',
    label: '词条回复撤回',
    description: '词条回复多少秒后撤回，0 不撤回',
    min: 0,
    default: 0,
    component: 'InputNumber',
  },
  bannedWords: {
    type: 'object',
    label: '违禁词策略',
    description: '词库在 data/bannedWords/{群号}.json；此处为开关与处罚',
    component: 'SubForm',
    fields: {
      enabled: {
        type: 'boolean',
        label: '启用检测',
        description: '命中词库后按禁言/仅警告执行',
        default: true,
        component: 'Switch',
      },
      muteTime: {
        type: 'number',
        label: '禁言时长',
        description: '分钟；仅警告开启时不禁言',
        min: 0,
        default: 720,
        component: 'InputNumber',
      },
      warnOnly: {
        type: 'boolean',
        label: '仅警告',
        description: '开启则只提示、不禁言',
        default: false,
        component: 'Switch',
      },
      exemptRoles: {
        type: 'array',
        label: '免检角色',
        description: 'owner / admin 等',
        itemType: 'string',
        default: [],
        component: 'Tags',
      },
    },
  },
};

export const chatbotConfig = {
  name: 'chatbot',
  displayName: '机器人业务',
  description:
    '主人、自动同意/退群、私聊、消息黑白名单、频道；以及群默认冷却/@/插件启停/词条与违禁词，可按群号覆盖',
  filePath: getConfigPath('chatbot'),
  fileType: 'yaml',
  schema: {
    meta: {
      collections: [
        {
          name: 'groupOverrides',
          type: 'keyedObject',
          component: 'keyedObject',
          label: '群单独配置',
          description: '键为群号，覆盖 default；存于本文件根级',
          basePath: '',
          excludeKeys: [...CHATBOT_FIXED_ROOT_KEYS],
          keyLabel: '群号',
          keyPlaceholder: '输入群号',
          valueTemplatePath: 'default',
        },
      ],
    },
    fields: {
      master: {
        type: 'object',
        label: '主人',
        description: '超级用户 QQ，权限与名单放行以此为准',
        component: 'SubForm',
        fields: {
          qq: {
            type: 'array',
            label: '主人 QQ',
            description: '写入 e.isMaster；黑白名单与私聊限制对主人放行',
            itemType: 'string',
            default: [],
            component: 'Tags',
          },
        },
      },
      auto: {
        type: 'object',
        label: '自动处理',
        description: '加好友与被拉进群时的自动策略',
        component: 'SubForm',
        fields: {
          friend: {
            type: 'number',
            label: '自动同意加好友',
            description: '1 同意，0 不处理',
            enum: [0, 1],
            options: [
              { label: '0 · 不处理', value: 0 },
              { label: '1 · 同意', value: 1 },
            ],
            default: 1,
            component: 'Select',
          },
          quit: {
            type: 'number',
            label: '自动退群人数阈值',
            description: '被拉进群时人数小于此值则退群；0 关闭',
            min: 0,
            default: 50,
            component: 'InputNumber',
          },
        },
      },
      private: {
        type: 'object',
        label: '私聊',
        component: 'SubForm',
        fields: {
          disabled: {
            type: 'boolean',
            label: '禁用私聊指令',
            description: '开启后非主人私聊默认拦截；含通行关键字则放行',
            default: false,
            component: 'Switch',
          },
          disabledMsg: {
            type: 'string',
            label: '拦截提示',
            default: '私聊功能已禁用',
            component: 'Input',
          },
          passKeywords: {
            type: 'array',
            label: '通行关键字',
            description: 'disabled 时消息含任一关键字仍放行；可留空',
            itemType: 'string',
            default: [],
            component: 'Tags',
          },
        },
      },
      whitelist: {
        type: 'object',
        label: '消息白名单',
        description: '非空则只处理名单内群/用户（主人除外）。与 HTTP 鉴权无关',
        component: 'SubForm',
        fields: {
          groups: {
            type: 'array',
            label: '白名单群',
            description: '非空时仅处理这些群的消息',
            itemType: 'string',
            default: [],
            component: 'Tags',
          },
          qq: {
            type: 'array',
            label: '白名单 QQ',
            description: '非空时仅处理这些用户（含私聊）',
            itemType: 'string',
            default: [],
            component: 'Tags',
          },
        },
      },
      blacklist: {
        type: 'object',
        label: '消息黑名单',
        description: '名单内群/用户直接丢弃（主人除外）',
        component: 'SubForm',
        fields: {
          groups: {
            type: 'array',
            label: '黑名单群',
            description: '这些群的消息一律丢弃',
            itemType: 'string',
            default: [],
            component: 'Tags',
          },
          qq: {
            type: 'array',
            label: '黑名单 QQ',
            description: '这些用户的消息一律丢弃',
            itemType: 'string',
            default: [],
            component: 'Tags',
          },
        },
      },
      guild: {
        type: 'object',
        label: '频道',
        description: 'QQ 频道（群号含 -）相关开关',
        component: 'SubForm',
        fields: {
          disableMsg: {
            type: 'boolean',
            label: '忽略频道消息',
            description: '群号含 - 时丢弃；主人除外',
            default: true,
            component: 'Switch',
          },
        },
      },
      default: {
        type: 'object',
        label: '群默认设置',
        description: '未单独配置的群使用；getGroup(id) = default ∪ 群号覆盖',
        component: 'SubForm',
        fields: groupEntryFields,
      },
    },
  },
};
