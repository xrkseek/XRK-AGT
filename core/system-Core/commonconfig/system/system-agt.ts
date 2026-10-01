import { getConfigPath } from './system-schema-helpers.js';
export const agtConfig = {
      name: 'agt',
      displayName: '全局配置',
      description: 'XRK-AGT全局配置，包括日志、浏览器、文件系统、系统行为等',
      filePath: getConfigPath('agt'),
      fileType: 'yaml',
      schema: {
        fields: {
          logging: {
            type: 'object',
            label: '日志配置',
            description: '控制台日志等级、头样式与对象打印',
            component: 'SubForm',
            fields: {
              level: {
            type: 'string',
            label: '日志等级',
            description: '日志输出等级。Mark时只显示执行命令，不显示聊天记录',
            enum: ['trace', 'debug', 'info', 'warn', 'fatal', 'mark', 'error', 'off'],
            default: 'info',
            component: 'Select'
          },
              align: {
            type: 'string',
            label: '日志头内容',
                description: '日志头内容自定义显示',
            component: 'Input'
          },
              color: {
            type: 'string',
            label: '日志头颜色方案',
            description: '选择日志头的颜色主题',
            enum: ['default', 'scheme1', 'scheme2', 'scheme3', 'scheme4', 'scheme5', 'scheme6', 'scheme7'],
            default: 'default',
            component: 'Select'
          },
              idLength: {
            type: 'number',
            label: '日志ID长度',
            description: '日志ID长度（默认16个字符）',
            min: 1,
            max: 64,
            default: 20,
            component: 'InputNumber'
          },
              idFiller: {
            type: 'string',
            label: 'ID美化字符',
            description: 'ID显示时的美化字符（用于填充空白）',
            enum: ['.', '·', '─', '•', '═', '»', '→'],
            default: '.',
            component: 'Select'
          },
              object: {
            type: 'object',
            label: '日志对象检查',
            description: 'util.inspect 打印对象时的深度与截断选项',
            component: 'SubForm',
            fields: {
              depth: {
                type: 'number',
                label: '检查深度',
                description: '对象嵌套展开的最大层级',
                min: 1,
                default: 10,
                component: 'InputNumber'
              },
              colors: {
                type: 'boolean',
                label: '彩色输出',
                description: '终端中对象键值是否使用 ANSI 颜色',
                default: true,
                component: 'Switch'
              },
              showHidden: {
                type: 'boolean',
                label: '显示隐藏属性',
                description: '是否打印对象的不可枚举属性',
                default: true,
                component: 'Switch'
              },
              showProxy: {
                type: 'boolean',
                label: '显示代理对象',
                description: 'Proxy 对象是否展开 target 内容',
                default: true,
                component: 'Switch'
              },
              getters: {
                type: 'boolean',
                label: '显示getters',
                description: '是否调用并打印 accessor getter 的值',
                default: true,
                component: 'Switch'
              },
              breakLength: {
                type: 'number',
                label: '换行长度',
                description: '单行超过此宽度时自动换行',
                min: 1,
                default: 100,
                component: 'InputNumber'
              },
              maxArrayLength: {
                type: 'number',
                label: '最大数组长度',
                description: '数组打印时最多显示的元素个数',
                min: 1,
                default: 100,
                component: 'InputNumber'
              },
              maxStringLength: {
                type: 'number',
                label: '最大字符串长度',
                description: '字符串打印时的截断字符数',
                min: 1,
                default: 1000,
                component: 'InputNumber'
              }
            }
          },
              maxLength: {
                type: 'number',
                label: '单条日志最大字符',
                description: 'RuntimeUtil.makeLog 超长截断阈值；不填则 info=5000、warn/error=16000',
                min: 2000,
                component: 'InputNumber'
              },
              truncateHead: {
                type: 'number',
                label: '截断保留头部字符',
                description: '超长时保留开头长度',
                min: 200,
                component: 'InputNumber'
              },
              truncateTail: {
                type: 'number',
                label: '截断保留尾部字符',
                description: '超长时保留结尾长度',
                min: 200,
                component: 'InputNumber'
              },
              dir: {
                type: 'string',
                label: '日志目录',
                description: '日志存储目录',
                default: 'logs',
                component: 'Input'
          },
              maxDays: {
                type: 'number',
                label: '主日志保留天数',
                description: '主日志文件保留天数',
                min: 1,
                default: 30,
                component: 'InputNumber'
          },
              traceDays: {
                type: 'number',
                label: 'Trace日志保留天数',
                description: 'Trace日志文件保留天数',
                min: 1,
                default: 1,
                component: 'InputNumber'
          },
              send: {
                type: 'object',
                label: '日志发送插件配置',
                description: '通过聊天插件转发日志时的行数与长度限制',
                component: 'SubForm',
                fields: {
                  defaultLines: {
            type: 'number',
                    label: '默认发送行数',
                    description: '未指定时每次转发的日志行数',
                    min: 1,
                    default: 120,
            component: 'InputNumber'
          },
                  maxLines: {
            type: 'number',
                    label: '最大发送行数',
                    description: '单次转发允许的最大行数',
            min: 1,
                    default: 1000,
            component: 'InputNumber'
          },
                  maxPerForward: {
            type: 'number',
                    label: '转发最大行数',
                    description: '合并转发时每段的行数上限',
            min: 1,
                    default: 30,
            component: 'InputNumber'
          },
                  maxLineLength: {
                    type: 'number',
                    label: '单行最大长度',
                    description: '超长行截断前的字符数上限',
                    min: 1,
                    default: 300,
                    component: 'InputNumber'
                  }
                }
              }
            }
          },
          browser: {
            type: 'object',
            label: '渲染器',
            description: '截图与浏览器自动化使用的渲染后端',
            component: 'SubForm',
            fields: {
              renderer: {
                type: 'string',
                label: '渲染后端',
                description: '详细配置: data/server_bots/{port}/renderers/{type}/config.yaml',
                enum: ['puppeteer', 'playwright'],
                default: 'playwright',
                component: 'Select'
              }
            }
          },
          files: {
            type: 'object',
            label: '文件系统配置',
            description: '文件监听、临时 URL 与违禁资源路径',
            component: 'SubForm',
            fields: {
              watch: {
                type: 'boolean',
                label: '监听文件变化',
                description: '是否监听文件变化',
                default: true,
                component: 'Switch'
              },
              urlTime: {
                type: 'number',
                label: '文件URL有效时间',
                description: '文件URL有效时间（分钟）',
                min: 1,
                default: 60,
                component: 'InputNumber'
              },
              urlTimes: {
                type: 'number',
                label: '文件URL访问次数',
                description: '文件URL访问次数限制',
                min: 1,
                default: 5,
                component: 'InputNumber'
              },
              messageDataPath: {
                type: 'string',
                label: '消息数据路径',
                description: '消息数据存储路径',
                default: 'data/messageJson/',
                component: 'Input'
              },
              bannedWordsPath: {
                type: 'string',
                label: '违禁词路径',
                description: '违禁词存储路径',
                default: 'data/bannedWords/',
                component: 'Input'
              },
              bannedImagesPath: {
                type: 'string',
                label: '违禁图片路径',
                description: '违禁图片存储路径',
                default: 'data/bannedWords/images/',
                component: 'Input'
              },
              bannedConfigPath: {
                type: 'string',
                label: '违禁词配置路径',
                description: '违禁词配置路径',
                default: 'data/bannedWords/config/',
                component: 'Input'
              }
            }
          },
          system: {
            type: 'object',
            label: '系统行为配置',
            description: '消息预处理与群聊过滤规则',
            component: 'SubForm',
            fields: {
              '/→#': {
                type: 'boolean',
                label: '斜杠转井号',
                description: '自动把 / 换成 #',
                default: true,
                component: 'Switch'
              },
              ignoreSelf: {
                type: 'boolean',
                label: '过滤自己',
                description: '群聊和频道中过滤自己的消息',
                default: true,
                component: 'Switch'
              }
            }
          },
          status: {
            type: 'object',
            label: '状态插件配置',
            description: '状态查询插件展示的系统信息项',
            component: 'SubForm',
            fields: {
              showNetwork: {
            type: 'boolean',
                label: '显示网络信息',
            description: '状态插件是否显示网络信息',
            default: true,
            component: 'Switch'
          },
              showProcess: {
            type: 'boolean',
                label: '显示进程信息',
            description: '状态插件是否显示进程信息',
            default: true,
            component: 'Switch'
          },
              showDisk: {
            type: 'boolean',
                label: '显示磁盘信息',
            description: '状态插件是否显示磁盘信息',
            default: true,
            component: 'Switch'
              }
            }
          },
          autoUpdate: {
            type: 'object',
            label: '自动更新',
            description: '定时/间隔静默更新；有更新或失败才推送主人',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用定时更新',
                description: '按 cron 表达式自动 git pull 检查更新',
                default: true,
                component: 'Switch'
              },
              cron: {
                type: 'string',
                label: 'Cron',
                description: 'node-schedule：秒 分 时 日 月 周，默认每天 12:00；YAML 也可写成数组',
                default: '0 0 12 * * *',
                component: 'Input'
              },
              forceOnConflict: {
                type: 'boolean',
                label: '冲突才强制',
                description: '先普通 pull，仅冲突时 reset --hard',
                default: true,
                component: 'Switch'
              }
            }
          }
        }
      }
    }
