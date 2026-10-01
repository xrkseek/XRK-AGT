import { getConfigPath } from './system-schema-helpers.js';
export const deviceConfig = {
      name: 'device',
      displayName: '设备管理配置',
      description: '设备管理的核心参数配置',
      filePath: getConfigPath('device'),
      fileType: 'yaml',
      schema: {
        fields: {
          heartbeat: {
            type: 'object',
            label: '心跳配置',
            description: '设备在线状态探测与超时判定',
            component: 'SubForm',
            fields: {
              interval: {
            type: 'number',
            label: '心跳发送间隔',
            description: '设备定期上报在线状态的间隔（秒）',
            min: 1,
            default: 30,
            component: 'InputNumber'
          },
              timeout: {
            type: 'number',
            label: '心跳超时时间',
            description: '超过此时间未收到心跳则判定设备离线（秒）',
            min: 1,
                default: 1800,
            component: 'InputNumber'
              }
            }
          },
          limits: {
            type: 'object',
            label: '容量限制配置',
            description: '单设备资源占用上限',
            component: 'SubForm',
            fields: {
              maxLogsPerDevice: {
            type: 'number',
            label: '设备最大日志条数',
            description: '每台设备保留的日志条目上限，超出丢弃最旧记录',
            min: 1,
            default: 100,
            component: 'InputNumber'
              }
            }
          },
          command: {
            type: 'object',
            label: '命令处理配置',
            description: '下发至设备的远程命令执行参数',
            component: 'SubForm',
            fields: {
              timeout: {
            type: 'number',
            label: '命令执行超时',
            description: '等待设备返回命令结果的最长时间（毫秒）',
            min: 100,
            default: 5000,
            component: 'InputNumber'
              }
            }
          },
          websocket: {
            type: 'object',
            label: 'WebSocket配置',
            description: '设备长连接保活与 pong 检测',
            component: 'SubForm',
            fields: {
              pongTimeout: {
                type: 'number',
                label: 'Pong超时（毫秒）',
                description: '发送 ping 后等待 pong 的最长时间，超时则断开连接',
                default: 10000,
                component: 'InputNumber'
              }
            }
          },
          messageQueue: {
            type: 'object',
            label: '消息队列配置',
            description: '设备离线时待下发消息的缓冲',
            component: 'SubForm',
            fields: {
              size: {
                type: 'number',
                label: '消息队列大小',
                description: '每台设备待发送消息的最大排队条数',
                default: 100,
                component: 'InputNumber'
              }
            }
          },
          logging: {
            type: 'object',
            label: '日志配置',
            description: '设备管理模块的日志详细程度',
            component: 'SubForm',
            fields: {
              enableDetailedLogs: {
                type: 'boolean',
                label: '启用详细日志',
                description: '记录心跳、命令与 WebSocket 事件的详细信息',
                default: true,
                component: 'Switch'
              }
            }
          },
          audio: {
            type: 'object',
            label: '音频配置',
            description: '设备上传音频的本地存储',
            component: 'SubForm',
            fields: {
              saveDir: {
                type: 'string',
                label: '音频保存目录',
                description: '设备上报 WAV 等音频文件的落盘路径',
                default: './data/wav',
                component: 'Input'
              }
            }
          }
        }
      }
    }
