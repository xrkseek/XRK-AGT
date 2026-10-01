import { getConfigPath } from './system-schema-helpers.js';
export const monitorConfig = {
      name: 'monitor',
      displayName: '系统监控配置',
      description: '资源监控；企业默认仅观察+本进程 GC，杀浏览器/删文件/改系统须显式开启',
      filePath: getConfigPath('monitor'),
      fileType: 'yaml',
      schema: {
        fields: {
          enabled: {
            type: 'boolean',
            label: '监控总开关',
            description: '关闭后不再定时采样与告警',
            default: true,
            component: 'Switch'
          },
          interval: {
            type: 'number',
            label: '监控检查间隔',
            description: '定时检查间隔（毫秒）',
            min: 1000,
            default: 300000,
            component: 'InputNumber'
          },
          browser: {
            type: 'object',
            label: '浏览器进程监控',
            description: '扫描浏览器进程；杀进程须显式开启',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用浏览器监控',
                description: '会扫描并可能结束浏览器进程，企业默认关闭',
                default: false,
                component: 'Switch'
              },
              maxInstances: {
                type: 'number',
                label: '最大浏览器实例数',
                description: '超过则按策略清理旧实例',
                min: 1,
                default: 5,
                component: 'InputNumber'
              },
              memoryThreshold: {
                type: 'number',
                label: '内存阈值（%）',
                description: '单实例内存占比超阈值触发清理',
                min: 0,
                max: 100,
                default: 90,
                component: 'InputNumber'
              },
              reserveNewest: {
                type: 'boolean',
                label: '保留最新实例',
                description: '清理时优先保留最近启动的实例',
                default: true,
                component: 'Switch'
              }
            }
          },
          memory: {
            type: 'object',
            label: '系统内存监控',
            description: '系统/Node 堆观察与本进程 GC',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用内存监控',
                description: '关闭则不做内存采样与 GC',
                default: true,
                component: 'Switch'
              },
              systemThreshold: {
                type: 'number',
                label: '系统内存阈值（%）',
                description: '仅告警，不驱动 flushdns/GC',
                min: 0,
                max: 100,
                default: 90,
                component: 'InputNumber'
              },
              nodeThreshold: {
                type: 'number',
                label: 'Node堆内存阈值（%）',
                description: '仅堆超阈值才执行本进程 GC',
                min: 0,
                max: 100,
                default: 85,
                component: 'InputNumber'
              },
              autoOptimize: {
                type: 'boolean',
                label: '自动优化',
                description: '仅本进程 GC，不改系统',
                default: true,
                component: 'Switch'
              },
              gcInterval: {
                type: 'number',
                label: 'GC最小间隔（毫秒）',
                description: '两次 GC 之间的最短间隔',
                min: 1000,
                default: 600000,
                component: 'InputNumber'
              },
              leakDetection: {
                type: 'object',
                label: '内存泄漏检测',
                description: '观察堆增长趋势',
                component: 'SubForm',
                fields: {
                  enabled: {
                    type: 'boolean',
                    label: '启用泄漏检测',
                    description: '关闭则不做泄漏趋势判断',
                    default: true,
                    component: 'Switch'
                  },
                  threshold: {
                    type: 'number',
                    label: '泄漏阈值',
                    description: '相对增长超过该比例视为潜在泄漏（如 0.1=10%）',
                    min: 0,
                    max: 1,
                    default: 0.1,
                    component: 'InputNumber'
                  },
                  checkInterval: {
                    type: 'number',
                    label: '检查间隔（毫秒）',
                    min: 1000,
                    default: 300000,
                    component: 'InputNumber'
                  }
                }
              }
            }
          },
          cpu: {
            type: 'object',
            label: 'CPU监控',
            description: '采样本机 CPU 占用并在超阈值时告警',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用CPU监控',
                description: '关闭则不做 CPU 采样',
                default: true,
                component: 'Switch'
              },
              threshold: {
                type: 'number',
                label: 'CPU使用率阈值（%）',
                description: '持续超过该占用则告警',
                min: 0,
                max: 100,
                default: 90,
                component: 'InputNumber'
              },
              checkDuration: {
                type: 'number',
                label: 'CPU检查持续时间（毫秒）',
                description: '需在此窗口内持续超阈值才触发',
                min: 1000,
                default: 30000,
                component: 'InputNumber'
              }
            }
          },
          optimize: {
            type: 'object',
            label: '优化策略',
            description: '资源紧张时的清理与重启策略',
            component: 'SubForm',
            fields: {
              aggressive: {
                type: 'boolean',
                label: '激进模式',
                description: '更频繁清理；Windows 下才允许 flushdns',
                default: false,
                component: 'Switch'
              },
              autoRestart: {
                type: 'boolean',
                label: '自动重启',
                description: '严重时自动重启（企业默认禁止）',
                default: false,
                component: 'Switch'
              },
              restartThreshold: {
                type: 'number',
                label: '重启阈值（%）',
                description: '资源占用达到该百分比且允许重启时触发',
                min: 0,
                max: 100,
                default: 95,
                component: 'InputNumber'
              }
            }
          },
          report: {
            type: 'object',
            label: '报告配置',
            description: '周期性汇总资源状态并推送',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用报告',
                description: '按间隔生成监控摘要',
                default: true,
                component: 'Switch'
              },
              interval: {
                type: 'number',
                label: '报告间隔（毫秒）',
                description: '两次报告之间的最短间隔',
                min: 1000,
                default: 3600000,
                component: 'InputNumber'
              }
            }
          },
          disk: {
            type: 'object',
            label: '磁盘优化',
            description: '磁盘空间告警与可选的临时/日志清理',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用磁盘监控',
                description: '空间告警；自动删除须另开下方开关',
                default: true,
                component: 'Switch'
              },
              cleanupTemp: {
                type: 'boolean',
                label: '清理临时文件',
                description: '仅 data/temp；永不清理 uploads',
                default: false,
                component: 'Switch'
              },
              cleanupLogs: {
                type: 'boolean',
                label: '清理日志文件',
                description: '删除 logs/*.log（审计场景请保持关闭）',
                default: false,
                component: 'Switch'
              },
              tempMaxAge: {
                type: 'number',
                label: '临时文件最大年龄（毫秒）',
                description: '超过该年龄的 temp 文件可被清理',
                default: 86400000,
                component: 'InputNumber'
              },
              logMaxAge: {
                type: 'number',
                label: '日志文件最大年龄（毫秒）',
                description: '超过该年龄的日志可被清理',
                default: 604800000,
                component: 'InputNumber'
              },
              maxLogSize: {
                type: 'number',
                label: '单个日志文件最大大小（字节）',
                description: '单文件超过该大小可被轮转/清理',
                default: 104857600,
                component: 'InputNumber'
              }
            }
          },
          network: {
            type: 'object',
            label: '网络优化',
            description: '连接数探测与空闲连接清理（默认关闭）',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用网络优化',
                description: 'netstat 类探测，企业默认关闭',
                default: false,
                component: 'Switch'
              },
              maxConnections: {
                type: 'number',
                label: '最大连接数阈值',
                description: '连接数超过该值时告警或清理',
                min: 1,
                default: 1000,
                component: 'InputNumber'
              },
              cleanupIdle: {
                type: 'boolean',
                label: '清理空闲连接',
                description: '尝试关闭长时间空闲的连接',
                default: false,
                component: 'Switch'
              }
            }
          },
          process: {
            type: 'object',
            label: '进程优化',
            description: '调整本进程优先级（默认关闭）',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用进程优化',
                description: '会修改本进程优先级，企业默认关闭',
                default: false,
                component: 'Switch'
              },
              priority: {
                type: 'string',
                label: '进程优先级',
                description: '操作系统调度优先级档位',
                enum: ['low', 'normal', 'high'],
                default: 'normal',
                component: 'Select'
              },
              nice: {
                type: 'number',
                label: 'Linux nice值',
                description: 'Linux nice值 (-20到19)',
                min: -20,
                max: 19,
                default: 0,
                component: 'InputNumber'
              }
            }
          },
          system: {
            type: 'object',
            label: '系统级优化',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用系统优化',
                description: '系统级动作总开关，企业默认关闭',
                default: false,
                component: 'Switch'
              },
              clearCache: {
                type: 'boolean',
                label: '清理系统缓存',
                description: '如 flushdns；须配合激进模式',
                default: false,
                component: 'Switch'
              },
              optimizeCPU: {
                type: 'boolean',
                label: '优化CPU调度',
                description: 'Linux chrt 等，企业默认关闭',
                default: false,
                component: 'Switch'
              }
            }
          }
        }
      }
    }
