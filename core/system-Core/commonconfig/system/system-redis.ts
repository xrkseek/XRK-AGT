import { getConfigPath } from './system-schema-helpers.js';
export const redisConfig = {
      name: 'redis',
      displayName: 'Redis配置',
      description: 'Redis服务器连接配置',
      filePath: getConfigPath('redis'),
      fileType: 'yaml',
      schema: {
        required: ['host', 'port', 'db'],
        fields: {
          host: {
            type: 'string',
            label: 'Redis地址',
            description: 'Redis 实例的主机名或 IP，一般为 127.0.0.1 或 docker 容器名',
            default: '127.0.0.1',
            component: 'Input'
          },
          port: {
            type: 'number',
            label: 'Redis端口',
            description: 'Redis 监听端口，默认 6379',
            min: 1,
            max: 65535,
            default: 6379,
            component: 'InputNumber'
          },
          username: {
            type: 'string',
            label: 'Redis用户名',
            description: 'Redis 用户名（大多数单机环境可留空，仅启用 ACL/云服务时需要）',
            default: '',
            component: 'Input'
          },
          password: {
            type: 'string',
            label: 'Redis密码',
            description: 'Redis 密码，留空表示无密码；生产环境建议务必设置',
            default: '',
            component: 'InputPassword'
          },
          db: {
            type: 'number',
            label: 'Redis数据库',
            description: '逻辑库序号，默认 0，不同值相当于不同命名空间',
            min: 0,
            default: 0,
            component: 'InputNumber'
          },
          options: {
            type: 'object',
            label: 'Redis连接选项',
            component: 'SubForm',
            fields: {
              connectTimeout: {
                type: 'number',
                label: '连接超时时间（毫秒）',
                description: '与 Redis 建立 TCP 连接的超时时间，单位毫秒',
                min: 1000,
                default: 10000,
                component: 'InputNumber'
              }
            }
          }
        }
      }
    }
