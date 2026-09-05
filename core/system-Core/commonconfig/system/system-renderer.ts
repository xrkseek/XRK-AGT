// @ts-nocheck
import { getPort } from './system-schema-helpers.js';
import path from 'path';
import paths from '#utils/paths.js';
import runtimeConfig from '#infrastructure/config/config.js';

const VIEWPORT_FIELDS = {
  type: 'object',
  label: '视口',
  description: '默认截图视口；单次渲染仍可覆盖',
  component: 'SubForm',
  fields: {
    width: {
      type: 'number',
      label: '宽',
      description: 'CSS 像素宽度',
      min: 1,
      default: 1280,
      component: 'InputNumber',
    },
    height: {
      type: 'number',
      label: '高',
      description: 'CSS 像素高度',
      min: 1,
      default: 720,
      component: 'InputNumber',
    },
    deviceScaleFactor: {
      type: 'number',
      label: '缩放',
      description: 'devicePixelRatio，1=普通，2=高清',
      min: 0.1,
      max: 5,
      default: 1,
      component: 'InputNumber',
    },
  },
};

export const rendererConfig = {
  name: 'renderer',
  displayName: '渲染器配置',
  description:
    'Puppeteer/Playwright 截图；运行时 data/server_bots/{port}/renderers/{type}/config.yaml，缺省从 src/renderers/{type}/config_default.yaml 合并',
  filePath: (runtimeConfig) => {
    const port = getPort(runtimeConfig);
    if (!port) throw new Error('SystemConfig: 渲染器配置需要端口号');
    return `data/server_bots/${port}/renderers/{type}/config.yaml`;
  },
  fileType: 'yaml',
  multiFile: {
    keys: ['puppeteer', 'playwright'],
    getFilePath: (key) => {
      const port = getPort(runtimeConfig);
      if (!port) throw new Error('SystemConfig: 渲染器配置需要端口号');
      return path.join(paths.root, `data/server_bots/${port}/renderers/${key}/config.yaml`);
    },
    getDefaultFilePath: (key) => path.join(paths.renderers, key, 'config_default.yaml'),
  },
  schema: {
    fields: {
      puppeteer: {
        type: 'object',
        label: 'Puppeteer',
        description: 'Chromium 截图引擎（agt.browser.renderer=puppeteer 时使用）',
        component: 'SubForm',
        fields: {
          headless: {
            type: 'string',
            label: '无头模式',
            description: 'new=新无头；old=旧无头；false=有界面调试',
            enum: ['new', 'old', 'false'],
            default: 'new',
            component: 'Select',
          },
          chromiumPath: {
            type: 'string',
            label: 'Chromium 路径',
            description: '可执行文件绝对路径；空则用内置/环境探测',
            default: '',
            component: 'Input',
          },
          wsEndpoint: {
            type: 'string',
            label: '远程 WS 地址',
            description: '连已有浏览器（browserWSEndpoint）；非空时忽略本地启动',
            default: '',
            component: 'Input',
          },
          args: {
            type: 'array',
            label: '启动参数',
            description: 'Chromium CLI 参数',
            itemType: 'string',
            default: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
            component: 'Tags',
          },
          puppeteerTimeout: {
            type: 'number',
            label: '截图超时(ms)',
            description: '单次 page 操作超时',
            min: 1000,
            default: 120000,
            component: 'InputNumber',
          },
          restartNum: {
            type: 'number',
            label: 'N 次后重启',
            description: '累计截图 N 次后重启浏览器，防内存涨',
            min: 1,
            default: 150,
            component: 'InputNumber',
          },
          viewport: VIEWPORT_FIELDS,
        },
      },
      playwright: {
        type: 'object',
        label: 'Playwright',
        description: '默认推荐引擎（agt.browser.renderer=playwright）',
        component: 'SubForm',
        fields: {
          browserType: {
            type: 'string',
            label: '浏览器',
            description: 'chromium / firefox / webkit',
            enum: ['chromium', 'firefox', 'webkit'],
            default: 'chromium',
            component: 'Select',
          },
          headless: {
            type: 'boolean',
            label: '无头',
            description: '关闭则弹出可视窗口（调试用）',
            default: true,
            component: 'Switch',
          },
          chromiumPath: {
            type: 'string',
            label: 'Chromium 路径',
            description: 'executablePath；空则用 Playwright 自带浏览器',
            default: '',
            component: 'Input',
          },
          wsEndpoint: {
            type: 'string',
            label: '远程 WS 地址',
            description: 'connectOverCDP / 远程浏览器端点',
            default: '',
            component: 'Input',
          },
          args: {
            type: 'array',
            label: '启动参数',
            description: '浏览器启动 args',
            itemType: 'string',
            default: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
            component: 'Tags',
          },
          playwrightTimeout: {
            type: 'number',
            label: '截图超时(ms)',
            description: '默认 navigation/action 超时',
            min: 1000,
            default: 120000,
            component: 'InputNumber',
          },
          healthCheckInterval: {
            type: 'number',
            label: '健康检查(ms)',
            description: '定期探活浏览器进程的间隔',
            min: 1000,
            default: 60000,
            component: 'InputNumber',
          },
          maxRetries: {
            type: 'number',
            label: '重试次数',
            description: '截图失败后的最大重试',
            min: 0,
            default: 3,
            component: 'InputNumber',
          },
          retryDelay: {
            type: 'number',
            label: '重试延迟(ms)',
            description: '两次重试之间的等待',
            min: 100,
            default: 2000,
            component: 'InputNumber',
          },
          restartNum: {
            type: 'number',
            label: 'N 次后重启',
            description: '累计截图 N 次后重启浏览器',
            min: 1,
            default: 150,
            component: 'InputNumber',
          },
          viewport: VIEWPORT_FIELDS,
          contextOptions: {
            type: 'object',
            label: '上下文',
            description: 'BrowserContext 默认选项',
            component: 'SubForm',
            fields: {
              bypassCSP: {
                type: 'boolean',
                label: '绕过 CSP',
                description: '便于内联脚本/样式的模板页',
                default: true,
                component: 'Switch',
              },
              reducedMotion: {
                type: 'string',
                label: '减少动画',
                description: 'emulate reduced-motion，截图更稳',
                enum: ['reduce', 'no-preference'],
                default: 'reduce',
                component: 'Select',
              },
            },
          },
        },
      },
    },
  },
};
