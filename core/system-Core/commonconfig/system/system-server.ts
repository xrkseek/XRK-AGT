import { getConfigPath } from './system-schema-helpers.js';
export const serverConfig = {
      name: 'server',
      displayName: '服务器配置',
      description: 'HTTP/HTTPS服务器、反向代理、SSL证书等配置',
      filePath: getConfigPath('server'),
      fileType: 'yaml',
      schema: {
        fields: {
          server: {
            type: 'object',
            label: '基础配置',
            description: 'HTTP 服务监听地址与对外展示 URL',
            component: 'SubForm',
            fields: {
              name: {
                type: 'string',
                label: '服务器名称',
                description: '用于日志与启动信息中的服务标识',
                component: 'Input'
              },
              host: {
                type: 'string',
                label: '监听地址',
                description: '0.0.0.0: 监听所有网络接口，127.0.0.1: 仅监听本地',
                default: '0.0.0.0',
                component: 'Input'
              },
              url: {
                type: 'string',
                label: '外部访问URL',
                description: '启动展示与 Web 控制台基址；留空则公网 IP（detectPublicIP）或 127.0.0.1',
                default: '',
                component: 'Input'
              }
            }
          },
          proxy: {
            type: 'object',
            label: '反向代理配置',
            description: '多域名反向代理、负载均衡与上游健康检查',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用反向代理',
                description: '开启后按 domains 配置转发请求至后端',
                default: false,
                component: 'Switch'
              },
              httpPort: {
                type: 'number',
                label: 'HTTP端口',
                description: '反向代理监听 HTTP 端口，通常 80',
                min: 1,
                max: 65535,
                default: 80,
                component: 'InputNumber'
              },
              httpsPort: {
                type: 'number',
                label: 'HTTPS端口',
                description: '反向代理监听 HTTPS 端口，通常 443',
                min: 1,
                max: 65535,
                default: 443,
                component: 'InputNumber'
              },
              healthCheck: {
                type: 'object',
                label: '健康检查配置',
                description: '定期探测上游可用性，失败时跳过不健康节点',
                component: 'SubForm',
                fields: {
                  enabled: {
                    type: 'boolean',
                    label: '启用健康检查',
                    description: '开启后对上游 target 定期发起探测',
                    default: false,
                    component: 'Switch'
                  },
                  interval: {
                    type: 'number',
                    label: '检查间隔',
                    description: '检查间隔（毫秒）',
                    min: 1000,
                    default: 30000,
                    component: 'InputNumber'
                  },
                  maxFailures: {
                    type: 'number',
                    label: '最大失败次数',
                    description: '超过后标记为不健康',
                    min: 1,
                    default: 3,
                    component: 'InputNumber'
                  },
                  timeout: {
                    type: 'number',
                    label: '健康检查超时',
                    description: '健康检查超时时间（毫秒）',
                    min: 1000,
                    default: 5000,
                    component: 'InputNumber'
                  },
                  cacheTime: {
                    type: 'number',
                    label: '结果缓存时间',
                    description: '健康检查结果缓存时间（毫秒），减少频繁检查',
                    min: 0,
                    default: 5000,
                    component: 'InputNumber'
                  },
                  path: {
                    type: 'string',
                    label: '健康检查路径',
                    description: '自定义健康检查路径（可选，默认/health）',
                    component: 'Input',
                    placeholder: '/health'
                  }
                }
              },
              domains: {
                type: 'array',
                label: '域名配置列表',
                description: '支持多域名配置，每个域名可以有不同的配置',
                component: 'ArrayForm',
                itemType: 'object',
                fields: {
                  domain: {
                    type: 'string',
                    label: '域名',
                    description: '匹配的 Host 头，支持通配符',
                    required: true,
                    component: 'Input',
                    placeholder: 'xrkk.cc'
                  },
                  staticRoot: {
                    type: 'string',
                    label: '静态文件根目录',
                    description: '该域名下直接由代理提供的静态文件目录',
                    component: 'Input',
                    placeholder: './core/system-Core/site'
                  },
                  target: {
                    type: 'string',
                    label: '目标服务器',
                    description: '单个服务器URL，或数组形式配置多个服务器启用负载均衡',
                    component: 'Input',
                    placeholder: 'http://localhost:3000'
                  },
                  loadBalance: {
                    type: 'string',
                    label: '负载均衡算法',
                    description: '当target为数组时生效',
                    enum: ['round-robin', 'weighted', 'least-connections', 'ip-hash', 'consistent-hash', 'least-response-time'],
                    default: 'round-robin',
                    component: 'Select'
                  },
                  healthUrl: {
                    type: 'string',
                    label: '自定义健康检查URL',
                    description: '覆盖全局健康检查路径',
                    component: 'Input',
                    placeholder: 'http://localhost:3000/custom-health'
                  },
                  ssl: {
                    type: 'object',
                    label: 'SSL配置',
                    description: '该域名的 HTTPS 证书与 TLS 开关',
                    component: 'SubForm',
                    fields: {
                      enabled: {
                        type: 'boolean',
                        label: '启用SSL',
                        description: '为该域名启用 HTTPS 终止',
                        default: false,
                        component: 'Switch'
                      },
                      certificate: {
                        type: 'object',
                        label: '证书配置',
                        description: 'PEM 格式证书文件路径',
                        component: 'SubForm',
                        fields: {
                          key: {
                            type: 'string',
                            label: '私钥文件路径',
                            description: '服务器私钥 PEM 文件',
                            component: 'Input'
                          },
                          cert: {
                            type: 'string',
                            label: '证书文件路径',
                            description: '域名公钥证书 PEM 文件',
                            component: 'Input'
                          },
                          ca: {
                            type: 'string',
                            label: 'CA证书链',
                            description: '中间 CA 证书链，可选',
                            component: 'Input'
                          }
                        }
                      }
                    }
                  },
                  rewritePath: {
                    type: 'object',
                    label: '路径重写规则',
                    description: '转发前将请求路径从 from 替换为 to',
                    component: 'SubForm',
                    fields: {
                      from: {
                        type: 'string',
                        label: '源路径',
                        description: '客户端请求的原始路径前缀',
                        component: 'Input'
                      },
                      to: {
                        type: 'string',
                        label: '目标路径',
                        description: '转发至上游时使用的路径前缀',
                        component: 'Input'
                      }
                    }
                  },
                  preserveHostHeader: {
                    type: 'boolean',
                    label: '保持原始Host头',
                    description: '转发时保留客户端 Host，而非替换为 upstream 主机名',
                    default: false,
                    component: 'Switch'
                  },
                  ws: {
                    type: 'boolean',
                    label: 'WebSocket支持',
                    description: '允许该域名下的 WebSocket 升级与代理',
                    default: true,
                    component: 'Switch'
                  },
                  timeout: {
                    type: 'number',
                    label: '超时时间',
                    description: '代理超时时间（毫秒）',
                    min: 1000,
                    default: 30000,
                    component: 'InputNumber'
                  }
                }
              }
            }
          },
          redirects: {
            type: 'array',
            label: 'HTTP重定向配置',
            description: '支持301/302/307/308重定向，支持通配符和条件匹配',
            component: 'ArrayForm',
            itemType: 'object',
            fields: {
              from: {
                type: 'string',
                label: '源路径',
                description: '匹配此路径的请求将被重定向',
                required: true,
                component: 'Input',
                placeholder: '/old-path'
              },
              to: {
                type: 'string',
                label: '目标路径',
                description: '重定向目标 URL 或路径',
                required: true,
                component: 'Input',
                placeholder: '/new-path'
              },
              status: {
                type: 'number',
                label: 'HTTP状态码',
                description: '301/308 永久，302/307 临时',
                enum: [301, 302, 307, 308],
                default: 301,
                component: 'Select'
              },
              preserveQuery: {
                type: 'boolean',
                label: '保留查询参数',
                description: '重定向时附带原 URL 的 ?query 部分',
                default: true,
                component: 'Switch'
              },
              condition: {
                type: 'string',
                label: '条件表达式',
                description: 'JavaScript条件表达式（可选）',
                component: 'Input',
                placeholder: "req.headers['user-agent'].includes('Mobile')"
              }
            }
          },
          cdn: {
            type: 'object',
            label: 'CDN配置',
            description: '静态资源 CDN 域名与缓存头策略',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用CDN',
                description: '开启后静态资源 URL 指向 CDN 域名',
                default: false,
                component: 'Switch'
              },
              domain: {
                type: 'string',
                label: 'CDN域名',
                description: '对外提供静态资源的 CDN 主机名',
                component: 'Input',
                placeholder: 'cdn.example.com'
              },
              staticPrefix: {
                type: 'string',
                label: '静态资源前缀',
                description: 'CDN 上静态文件的路径前缀',
                default: '/static',
                component: 'Input'
              },
              https: {
                type: 'boolean',
                label: '使用HTTPS',
                description: '生成 CDN 链接时使用 https 协议',
                default: true,
                component: 'Switch'
              },
              type: {
                type: 'string',
                label: 'CDN类型',
                description: '用于优化CDN特定头部',
                enum: ['general', 'cloudflare', 'aliyun', 'tencent', 'aws', 'baidu', 'qiniu', 'ucloud'],
                default: 'general',
                component: 'Select'
              },
              cacheControl: {
                type: 'object',
                label: '缓存控制',
                description: 'CDN 响应 Cache-Control max-age 秒数',
                component: 'SubForm',
                fields: {
                  static: {
                    type: 'number',
                    label: '静态资源缓存（秒）',
                    description: 'CSS/JS/字体文件',
                    min: 0,
                    default: 31536000,
                    component: 'InputNumber'
                  },
                  images: {
                    type: 'number',
                    label: '图片缓存（秒）',
                    description: '图片类资源的 CDN 缓存时长',
                    min: 0,
                    default: 604800,
                    component: 'InputNumber'
                  },
                  default: {
                    type: 'number',
                    label: '默认缓存（秒）',
                    description: '未分类资源的默认 CDN 缓存时长',
                    min: 0,
                    default: 3600,
                    component: 'InputNumber'
                  }
                }
              }
            }
          },
          https: {
            type: 'object',
            label: 'HTTPS配置',
            description: '主服务 HTTPS 终止、证书与 HSTS',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用HTTPS',
                description: '主 HTTP 服务同时监听 TLS',
                default: false,
                component: 'Switch'
              },
              certificate: {
                type: 'object',
                label: '默认证书配置',
                description: '未匹配域名时的默认 PEM 证书',
                component: 'SubForm',
                fields: {
                  key: {
                    type: 'string',
                    label: '私钥文件路径',
                    description: '服务器私钥 PEM 文件',
                    component: 'Input'
                  },
                  cert: {
                    type: 'string',
                    label: '证书文件路径',
                    description: '公钥证书 PEM 文件',
                    component: 'Input'
                  },
                  ca: {
                    type: 'string',
                    label: 'CA证书链路径',
                    description: '中间 CA 证书链，可选',
                    component: 'Input'
                  }
                }
              },
              tls: {
                type: 'object',
                label: 'TLS配置',
                description: '最低协议版本与 HTTP/2 开关',
                component: 'SubForm',
                fields: {
                  minVersion: {
                    type: 'string',
                    label: '最低TLS版本',
                    description: '拒绝低于此版本的 TLS 握手',
                    enum: ['TLSv1.0', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'],
                    default: 'TLSv1.2',
                    component: 'Select'
                  },
                  http2: {
                    type: 'boolean',
                    label: '启用HTTP/2',
                    description: 'HTTPS 连接启用 HTTP/2 多路复用',
                    default: true,
                    component: 'Switch'
                  }
                }
              },
              hsts: {
                type: 'object',
                label: 'HSTS配置',
                description: 'Strict-Transport-Security 响应头',
                component: 'SubForm',
                fields: {
                  enabled: {
                    type: 'boolean',
                    label: '启用HSTS',
                    description: '告知浏览器仅通过 HTTPS 访问',
                    default: false,
                    component: 'Switch'
                  },
                  maxAge: {
                    type: 'number',
                    label: '有效期',
                    description: '有效期（秒），31536000 = 1年',
                    min: 0,
                    default: 31536000,
                    component: 'InputNumber'
                  },
                  includeSubDomains: {
                    type: 'boolean',
                    label: '包含子域名',
                    description: 'HSTS 策略同时作用于所有子域名',
                    default: true,
                    component: 'Switch'
                  },
                  preload: {
                    type: 'boolean',
                    label: '允许预加载',
                    description: '允许提交至浏览器 HSTS 预加载列表',
                    default: false,
                    component: 'Switch'
                  }
                }
              }
            }
          },
          static: {
            type: 'object',
            label: '静态文件服务',
            description: '本地静态目录索引、扩展名与缓存',
            component: 'SubForm',
            fields: {
              index: {
                type: 'array',
                label: '默认首页文件',
                description: '目录访问时按顺序尝试的文件名',
                itemType: 'string',
                default: ['index.html', 'index.htm', 'default.html'],
                component: 'Tags'
              },
              extensions: {
                type: 'boolean',
                label: '自动添加扩展名',
                description: '无扩展名请求时尝试补 .html 等',
                default: false,
                component: 'Switch'
              },
              cache: {
                type: 'object',
                label: '静态资源缓存',
                description: '静态文件服务的 HTTP 缓存（秒），用于 CSS/JS/图片等',
                component: 'SubForm',
                fields: {
                  static: {
                    type: 'number',
                    label: '静态资源缓存（秒）',
                    description: 'CSS/JS/字体文件',
                    min: 0,
                    default: 86400,
                    component: 'InputNumber'
                  },
                  images: {
                    type: 'number',
                    label: '图片缓存（秒）',
                    description: '图片类静态文件的 Cache-Control max-age',
                    min: 0,
                    default: 604800,
                    component: 'InputNumber'
                  }
                }
              },
              cacheTime: {
                type: 'string',
                label: '缓存时间',
                description: '支持格式：1d = 1天, 1h = 1小时',
                default: '1d',
                component: 'Input'
              },
              dataCacheTime: {
                type: 'string',
                label: '数据目录缓存时间',
                description: 'data 目录静态文件缓存时间（如 /media, /uploads），默认 1 小时：1h',
                default: '1h',
                component: 'Input'
              }
            }
          },
          robots: {
            type: 'object',
            label: 'robots.txt 配置',
            description: '爬虫访问规则与 Sitemap 声明',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用 robots.txt 路由',
                default: true,
                component: 'Switch'
              },
              disallow: {
                type: 'array',
                label: 'Disallow 路径',
                description:
                  '禁止爬虫访问的路径前缀。/xrk、/core/ 会由运行时强制并入，勿依赖 Allow: /',
                itemType: 'string',
                default: [
                  '/xrk',
                  '/xrk/',
                  '/core/',
                  '/api/',
                  '/config/',
                  '/data/',
                  '/lib/',
                  '/plugins/',
                  '/trash/',
                ],
                component: 'Tags'
              },
              allow: {
                type: 'array',
                label: 'Allow 路径',
                description: '允许爬虫访问的路径前缀；控制台场景建议留空，勿填 /',
                itemType: 'string',
                default: [],
                component: 'Tags'
              },
              autoSitemap: {
                type: 'boolean',
                label: '自动追加 Sitemap 行',
                description: '为 robots.txt 自动追加 Sitemap: {url}/sitemap.xml',
                default: true,
                component: 'Switch'
              },
              sitemapPath: {
                type: 'string',
                label: 'Sitemap 路径',
                description: 'autoSitemap 追加的 Sitemap URL 路径',
                default: '/sitemap.xml',
                component: 'Input'
              },
              content: {
                type: 'string',
                label: '覆盖内容（可选）',
                description: '不为空时完全覆盖默认 robots.txt 内容',
                component: 'Textarea'
              }
            }
          },
          security: {
            type: 'object',
            label: '安全配置',
            description: 'HTTP 安全头与敏感路径隐藏',
            component: 'SubForm',
            fields: {
              helmet: {
                type: 'object',
                label: 'Helmet安全头',
                description: '自动设置 X-Frame-Options 等常见安全响应头',
                component: 'SubForm',
                fields: {
                  enabled: {
                    type: 'boolean',
                    label: '启用Helmet',
                    description: '开启 helmet 中间件注入安全头',
                    default: true,
                    component: 'Switch'
                  }
                }
              },
              hiddenFiles: {
                type: 'array',
                label: '隐藏文件模式',
                description: '匹配这些模式的文件将返回404，注意：这些模式不会影响 /api/* 路径',
                itemType: 'string',
                default: ['^\\..*', 'node_modules', '\\.git', '\\.env', '^/config/', '^/private/'],
                component: 'Tags'
              }
            }
          },
          cors: {
            type: 'object',
            label: 'CORS配置',
            description: '跨域资源共享策略',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用CORS',
                description: '为浏览器跨域请求添加 Access-Control-* 头',
                default: true,
                component: 'Switch'
              },
              origins: {
                type: 'array',
                label: '允许的来源',
                description: '允许的 Origin，* 表示任意来源',
                itemType: 'string',
                default: ['*'],
                component: 'Tags'
              },
              methods: {
                type: 'array',
                label: '允许的方法',
                description: '预检与实际请求允许的 HTTP 方法',
                itemType: 'string',
                default: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
                component: 'MultiSelect'
              },
              headers: {
                type: 'array',
                label: '允许的请求头',
                description: '客户端可携带的自定义请求头',
                itemType: 'string',
                default: ['Content-Type', 'Authorization', 'X-API-Key'],
                component: 'Tags'
              },
              credentials: {
                type: 'boolean',
                label: '允许凭证',
                description: '是否允许携带 Cookie 等凭证',
                default: false,
                component: 'Switch'
              },
              maxAge: {
                type: 'number',
                label: '预检缓存时间',
                description: '预检请求缓存时间（秒）',
                min: 0,
                default: 86400,
                component: 'InputNumber'
              },
              exposeHeaders: {
                type: 'array',
                label: '暴露的响应头',
                description: 'Access-Control-Expose-Headers，允许前端 JS 读取的响应头列表',
                itemType: 'string',
                default: ['X-Request-Id', 'X-Response-Time'],
                component: 'Tags'
              }
            }
          },
          auth: {
            type: 'object',
            label: '认证配置',
            description: 'API Key 鉴权与白名单路径',
            component: 'SubForm',
            fields: {
              apiKey: {
                type: 'object',
                label: 'API密钥配置',
                description: 'HTTP API 的 X-API-Key 鉴权',
                component: 'SubForm',
                fields: {
                  enabled: {
                    type: 'boolean',
                    label: '启用API密钥',
                    description: '未命中白名单的请求须携带有效 API Key',
                    default: true,
                    component: 'Switch'
                  },
                  file: {
                    type: 'string',
                    label: '密钥存储文件',
                    description: 'API Key 的 JSON 持久化路径',
                    default: 'config/server_config/api_key.json',
                    component: 'Input'
                  },
                  length: {
                    type: 'number',
                    label: '密钥长度',
                    description: '自动生成新 Key 时的字符数',
                    min: 16,
                    max: 128,
                    default: 64,
                    component: 'InputNumber'
                  }
                }
              },
              requireLoopbackAuthWhenToolsRun: {
                type: 'boolean',
                label: '工具 run 开启时强制 loopback 鉴权',
                description: 'ai-workflow.tools.file.runEnabled=true 时，127.* 也须携带 API Key（默认 true）',
                default: true,
                component: 'Switch'
              },
              loopbackExempt: {
                type: 'boolean',
                label: '本机回环免 API Key',
                description:
                  '仅当 Host 为本机且 TCP 对端为 127.*、且无公网反代头时免 Key。默认关闭。公网/nginx/frp 部署务必保持关闭，否则可能裸奔',
                default: false,
                component: 'Switch'
              },
              whitelist: {
                type: 'array',
                label: '白名单路径（免 API Key）',
                description:
                  '仅作用于走 API Key 的 /api 路由。勿填「/」或「/api」（会放行全部，启动时忽略）。/health、/status、/xrk 静态页本就不校验 Key，无需列入。尾部 * 表示前缀；或以 ^ / regex: 写正则',
                itemType: 'string',
                default: [],
                component: 'Tags'
              }
            }
          },
          rateLimit: {
            type: 'object',
            label: '速率限制',
            description: '全站与 /api 路径的请求频率上限',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用速率限制',
                description: '超出限额时返回 429',
                default: true,
                component: 'Switch'
              },
              global: {
                type: 'object',
                label: '全局限制',
                description: '所有路由共享的滑动窗口限额',
                component: 'SubForm',
                fields: {
                  windowMs: {
                    type: 'number',
                    label: '时间窗口',
                    description: '时间窗口（毫秒）',
                    min: 1000,
                    default: 900000,
                    component: 'InputNumber'
                  },
                  max: {
                    type: 'number',
                    label: '最大请求数',
                    description: '窗口内允许的最大请求次数',
                    min: 1,
                    default: 1000,
                    component: 'InputNumber'
                  },
                  message: {
                    type: 'string',
                    label: '提示信息',
                    description: '触发限流时返回给客户端的文案',
                    default: '请求过于频繁，请稍后再试',
                    component: 'Input'
                  }
                }
              },
              api: {
                type: 'object',
                label: 'API限制',
                description: '/api 路径专用的更严格限额',
                component: 'SubForm',
                fields: {
                  windowMs: {
                    type: 'number',
                    label: '时间窗口',
                    description: 'API 限流滑动窗口（毫秒）',
                    min: 1000,
                    default: 60000,
                    component: 'InputNumber'
                  },
                  max: {
                    type: 'number',
                    label: '最大请求数',
                    description: '窗口内 /api 允许的最大请求次数',
                    min: 1,
                    default: 60,
                    component: 'InputNumber'
                  },
                  message: {
                    type: 'string',
                    label: '提示信息',
                    description: 'API 限流触发时的响应文案',
                    default: 'API请求过于频繁',
                    component: 'Input'
                  }
                }
              }
            }
          },
          limits: {
            type: 'object',
            label: '请求限制',
            description: '请求体大小与 multipart 文件数量上限',
            component: 'SubForm',
            fields: {
              urlencoded: {
                type: 'string',
                label: 'URL编码数据',
                description: 'application/x-www-form-urlencoded 最大体积',
                default: '10mb',
                component: 'Input'
              },
              json: {
                type: 'string',
                label: 'JSON数据',
                description: 'application/json 请求体最大体积',
                default: '10mb',
                component: 'Input'
              },
              raw: {
                type: 'string',
                label: '原始数据',
                description: 'application/octet-stream 等原始体最大体积',
                default: '50mb',
                component: 'Input'
              },
              text: {
                type: 'string',
                label: '文本数据',
                description: 'text/* 请求体最大体积',
                default: '10mb',
                component: 'Input'
              },
              fileSize: {
                type: 'string',
                label: '文件上传',
                description: '单个上传文件的最大体积',
                default: '100mb',
                component: 'Input'
              },
              files: {
                type: 'number',
                label: '上传文件数限制',
                description: 'multipart 单次请求最大文件数量',
                min: 1,
                default: 8,
                component: 'InputNumber'
              }
            }
          },
          contentSafety: {
            type: 'object',
            label: '内容安全（HTTP侧）',
            description: 'HTTP 入口对 AI 输入与上传内容的合规检测',
            component: 'SubForm',
            fields: {
              http: {
                type: 'object',
                label: 'HTTP入口检测',
                description: '在 API 层拦截违规文本或文件哈希',
                component: 'SubForm',
                fields: {
                  enabled: {
                    type: 'boolean',
                    label: '启用内容安全',
                    description: '开启后对匹配的请求做合规校验',
                    default: true,
                    component: 'Switch'
                  },
                  action: {
                    type: 'string',
                    label: '命中后的处理方式',
                    description: 'reject 直接拒绝，warn 仅记录警告',
                    enum: ['reject', 'warn'],
                    default: 'reject',
                    component: 'Select'
                  },
                  checkAiInput: {
                    type: 'boolean',
                    label: '检测 AI 输入文本',
                    description: '对发往 LLM 的用户文本做敏感词等检测',
                    default: true,
                    component: 'Switch'
                  },
                  checkUploadMd5: {
                    type: 'boolean',
                    label: '检测上传文件哈希',
                    description: '比对上传文件的 MD5 是否在违禁库中',
                    default: true,
                    component: 'Switch'
                  }
                }
              }
            }
          },
          outbound: {
            type: 'object',
            label: '外联请求',
            component: 'SubForm',
            fields: {
              proxy: {
                type: 'string',
                label: '统一代理',
                description: '如：http://127.0.0.1:<port>，留空表示不走代理',
                default: '',
                component: 'Input'
              }
            }
          },
          compression: {
            type: 'object',
            label: '压缩配置',
            description: 'gzip/br 响应压缩策略',
            component: 'SubForm',
            fields: {
              enabled: {
                type: 'boolean',
                label: '启用压缩',
                description: '对可压缩的响应体启用 gzip 等',
                default: true,
                component: 'Switch'
              },
              level: {
                type: 'number',
                label: '压缩级别',
                description: '0: 无压缩，9: 最大压缩，推荐：6',
                min: 0,
                max: 9,
                default: 6,
                component: 'InputNumber'
              },
              threshold: {
                type: 'number',
                label: '最小压缩大小',
                description: '小于此大小的响应不会被压缩（字节）',
                min: 0,
                default: 1024,
                component: 'InputNumber'
              }
            }
          },
          logging: {
            type: 'object',
            label: '日志配置',
            description: 'HTTP 访问与错误日志开关',
            component: 'SubForm',
            fields: {
              requests: {
                type: 'boolean',
                label: '记录请求',
                description: '记录每个 HTTP 请求的方法、路径与耗时',
                default: true,
                component: 'Switch'
              },
              errors: {
                type: 'boolean',
                label: '记录错误',
                description: '记录 4xx/5xx 及未捕获异常',
                default: true,
                component: 'Switch'
              },
              debug: {
                type: 'boolean',
                label: '调试日志',
                description: '输出更详细的 HTTP 层调试信息',
                default: false,
                component: 'Switch'
              },
              quiet: {
                type: 'array',
                label: '静默路径',
                description: '这些路径不写入访问日志，减少噪音',
                itemType: 'string',
                default: ['/health', '/favicon.ico', '/robots.txt'],
                component: 'Tags'
              }
            }
          },
          performance: {
            type: 'object',
            label: '性能优化配置',
            description: '连接复用、HTTP/2 Push 与底层 Server 参数',
            component: 'SubForm',
            fields: {
              keepAlive: {
                type: 'object',
                label: 'Keep-Alive配置',
                description: 'TCP 长连接与空闲超时',
                component: 'SubForm',
                fields: {
                  enabled: {
                    type: 'boolean',
                    label: '启用Keep-Alive',
                    description: '允许客户端复用同一 TCP 连接',
                    default: true,
                    component: 'Switch'
                  },
                  initialDelay: {
                    type: 'number',
                    label: '初始延迟',
                    description: '初始延迟（毫秒）',
                    min: 0,
                    default: 1000,
                    component: 'InputNumber'
                  },
                  timeout: {
                    type: 'number',
                    label: '超时时间',
                    description: '超时时间（毫秒）',
                    min: 1000,
                    default: 120000,
                    component: 'InputNumber'
                  }
                }
              },
              http2Push: {
                type: 'object',
                label: 'HTTP/2 Server Push',
                component: 'SubForm',
                fields: {
                  enabled: {
                    type: 'boolean',
                    label: '启用HTTP/2 Push',
                    description: '需要HTTP/2支持',
                    default: false,
                    component: 'Switch'
                  },
                  criticalAssets: {
                    type: 'array',
                    label: '关键资源列表',
                    description: '自动推送的关键资源',
                    itemType: 'string',
                    component: 'Tags',
                    default: []
                  }
                }
              },
              connectionPool: {
                type: 'object',
                label: '连接池配置',
                description: '反向代理至上游时的 socket 池参数',
                component: 'SubForm',
                fields: {
                  maxSockets: {
                    type: 'number',
                    label: '最大Socket数',
                    description: '每个主机的最大socket数',
                    min: 1,
                    default: 50,
                    component: 'InputNumber'
                  },
                  maxFreeSockets: {
                    type: 'number',
                    label: '最大空闲Socket数',
                    description: '池中保留的空闲连接上限',
                    min: 1,
                    default: 10,
                    component: 'InputNumber'
                  },
                  timeout: {
                    type: 'number',
                    label: 'Socket超时时间',
                    description: 'socket超时时间（毫秒）',
                    min: 1000,
                    default: 30000,
                    component: 'InputNumber'
                  }
                }
              },
              httpServer: {
                type: 'object',
                label: 'HTTP/HTTPS 底层参数',
                component: 'SubForm',
                fields: {
                  maxHeadersCount: {
                    type: 'number',
                    label: '最大请求头数量',
                    description: 'http(s).Server.maxHeadersCount',
                    min: 0,
                    default: 2000,
                    component: 'InputNumber'
                  },
                  maxRequestsPerSocket: {
                    type: 'number',
                    label: '每个 Socket 最大请求数',
                    description: '0 表示无限制（适合长连接）',
                    min: 0,
                    default: 0,
                    component: 'InputNumber'
                  },
                  serverTimeout: {
                    type: 'number',
                    label: 'Server 超时时间',
                    description: 'Server.timeout（毫秒），2 分钟=120000',
                    min: 0,
                    default: 120000,
                    component: 'InputNumber'
                  },
                  headersTimeout: {
                    type: 'number',
                    label: 'Headers 超时时间',
                    description: 'Server.headersTimeout（毫秒），1 分钟=60000',
                    min: 0,
                    default: 60000,
                    component: 'InputNumber'
                  },
                  socketTimeout: {
                    type: 'number',
                    label: 'Socket 超时时间',
                    description: 'socket.setTimeout（毫秒），2 分钟=120000',
                    min: 0,
                    default: 120000,
                    component: 'InputNumber'
                  }
                }
              }
            }
          },
          misc: {
            type: 'object',
            label: '其他配置',
            description: '公网 IP 探测、trash 清理与内存缓存',
            component: 'SubForm',
            fields: {
              detectPublicIP: {
                type: 'boolean',
                label: '检测公网IP',
                description: 'server.url 为空时，用公网 IP 作为启动展示基址；关闭则回退 127.0.0.1',
                default: true,
                component: 'Switch'
              },
              publicIpApis: {
                type: 'array',
                label: '公网 IP API 列表',
                description: '按顺序依次尝试的公网 IP 查询接口，每行一个 URL',
                itemType: 'string',
                default: ['https://ifconfig.me/ip', 'https://api.ipify.org', 'https://icanhazip.com', 'https://ipinfo.io/ip'],
                component: 'Tags'
              },
              publicIpTimeoutMs: {
                type: 'number',
                label: '公网 IP 请求超时',
                description: '每个公网 IP API 调用的超时时间（毫秒）',
                min: 100,
                default: 3000,
                component: 'InputNumber'
              },
              trashCleanupIntervalMinutes: {
                type: 'number',
                label: 'trash 清理间隔（分钟）',
                description: '定时扫描并清理过期 trash 文件的间隔',
                min: 1,
                default: 60,
                component: 'InputNumber'
              },
              trashMaxAgeHours: {
                type: 'number',
                label: 'trash 最大保留时间（小时）',
                description: '超过此时间的 trash 文件将被自动删除',
                min: 1,
                default: 24,
                component: 'InputNumber'
              },
              trashPreserve: {
                type: 'array',
                label: 'trash 保留文件列表',
                description: '在 trash 目录中永久保留的文件/目录名称，每行一个',
                itemType: 'string',
                default: ['.gitignore', 'instruct.txt'],
                component: 'Tags'
              },
              cache: {
                type: 'object',
                label: '内部缓存（内存 TTL）',
                description: '内存键值缓存的默认过期时间，与静态文件/HTTP 缓存无关',
                component: 'SubForm',
                fields: {
                  ttlMs: {
                    type: 'number',
                    label: '默认缓存 TTL（毫秒）',
                    description: '内存键值缓存条目的默认过期时间',
                    min: 0,
                    default: 60000,
                    component: 'InputNumber'
                  }
                }
              }
            }
          }
        }
      }
    }
