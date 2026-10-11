import ConfigBase from '#infrastructure/commonconfig/commonconfig.js';

/**
 * 火山引擎 ASR 工厂配置管理
 * 管理火山引擎语音识别（ASR）相关配置
 * 支持前端编辑，配置文件位于 data/server_bots/{port}/volcengine_asr.yaml
 */
export default class VolcengineASRConfig extends ConfigBase {
  [key: string]: any;
  constructor() {
    super({
      name: 'volcengine_asr',
      displayName: '火山引擎 ASR 工厂配置',
      description: '火山引擎语音转文本（ASR）配置',
      filePath: (runtimeConfig: any) => {
        const port = runtimeConfig?.port ?? runtimeConfig?._port;
        if (!port) {
          throw new Error(`VolcengineASRConfig: 未提供端口，无法解析路径`);
        }
        return `data/server_bots/${port}/volcengine_asr.yaml`;
      },
      fileType: 'yaml',
      schema: {
        fields: {
          // WebSocket 连接配置
          wsUrl: {
            type: 'string',
            label: 'WebSocket 地址',
            description: '火山引擎 ASR WebSocket 服务地址（大模型异步接口），一般保持默认即可，如需切换区域/产品请按官方文档替换为对应的 wss 地址',
            default: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
            component: 'Input'
          },
          apiKey: {
            type: 'string',
            label: 'API Key（新控制台）',
            description: '新版控制台鉴权：仅填此项即可（请求头 X-Api-Key）。填了则忽略下方 App/Access Key',
            default: '',
            component: 'InputPassword'
          },
          appKey: {
            type: 'string',
            label: 'App Key（旧控制台）',
            description: '旧控制台 APP ID（X-Api-App-Key）；与 Access Key 成对使用',
            default: '',
            component: 'Input'
          },
          accessKey: {
            type: 'string',
            label: 'Access Key（旧控制台）',
            description: '旧控制台 Access Token（X-Api-Access-Key），不是 Secret Key',
            default: '',
            component: 'InputPassword'
          },
          resourceId: {
            type: 'string',
            label: '资源 ID',
            description:
              '1.0 小时版 volc.bigasr.sauc.duration / 并发版 volc.bigasr.sauc.concurrent；'
              + '2.0 小时版 volc.seedasr.sauc.duration / 并发版 volc.seedasr.sauc.concurrent（新建 2.0 应用须用 seedasr）',
            default: 'volc.bigasr.sauc.duration',
            component: 'Input'
          },

          // 音频默认参数（可按会话覆盖）
          format: {
            type: 'string',
            label: '音频格式（format）',
            description: '默认音频格式（pcm 等），可按会话覆盖',
            default: 'pcm',
            component: 'Input'
          },
          codec: {
            type: 'string',
            label: '音频编码（codec）',
            description: '默认音频编码（raw 等），可按会话覆盖',
            default: 'raw',
            component: 'Input'
          },
          sampleRate: {
            type: 'number',
            label: '采样率（Hz）',
            description: '默认采样率（如 16000），可按会话覆盖',
            enum: [8000, 16000, 24000],
            default: 16000,
            component: 'Select'
          },
          bits: {
            type: 'number',
            label: '采样位数（bits）',
            description: '默认位深（一般 16）',
            enum: [8, 16],
            default: 16,
            component: 'Select'
          },
          channel: {
            type: 'number',
            label: '声道数（channel）',
            description: '默认声道数（一般 1）',
            enum: [1, 2],
            default: 1,
            component: 'Select'
          },
          modelName: {
            type: 'string',
            label: '模型名称（model_name）',
            description: '火山 ASR request.model_name 默认值，可按会话覆盖',
            default: 'bigmodel',
            component: 'Input'
          },
          
          // 功能开关配置
          enableItn: {
            type: 'boolean',
            label: '启用 ITN',
            description: '是否启用逆文本标准化',
            default: true,
            component: 'Switch'
          },
          enablePunc: {
            type: 'boolean',
            label: '启用标点',
            description: '是否启用标点符号识别',
            default: true,
            component: 'Switch'
          },
          enableDdc: {
            type: 'boolean',
            label: '启用 DDC',
            description: '是否启用说话人分离',
            default: false,
            component: 'Switch'
          },
          showUtterances: {
            type: 'boolean',
            label: '输出分片结果',
            description: '是否显示中间识别结果',
            default: true,
            component: 'Switch'
          },
          enableAccelerateText: {
            type: 'boolean',
            label: '启用加速文本',
            description: '是否启用加速文本输出',
            default: true,
            component: 'Switch'
          },
          
          // 结果类型配置
          resultType: {
            type: 'string',
            label: '结果类型',
            description: '识别结果类型（full, incremental）',
            enum: ['full', 'incremental'],
            default: 'full',
            component: 'Select'
          },
          
          // 参数配置
          accelerateScore: {
            type: 'number',
            label: '加速阈值',
            description: '加速文本输出的置信度阈值',
            min: 0,
            max: 100,
            default: 15,
            component: 'InputNumber'
          },
          persistentWs: {
            type: 'boolean',
            label: '持久连接',
            description: '是否保持 WebSocket 连接',
            default: true,
            component: 'Switch'
          },
          idleCloseMs: {
            type: 'number',
            label: '空闲断开时间 (ms)',
            description: '连接空闲多长时间后自动断开',
            min: 0,
            default: 6000,
            component: 'InputNumber'
          },
          endWindowSize: {
            type: 'number',
            label: '结束窗口大小',
            description: '检测结束的窗口大小',
            min: 0,
            default: 350,
            component: 'InputNumber'
          },
          forceToSpeechTime: {
            type: 'number',
            label: '强制语音检测时间 (ms)',
            description: '强制检测为语音的时间',
            min: 0,
            default: 500,
            component: 'InputNumber'
          },
          maxAudioBufferSize: {
            type: 'number',
            label: '最大音频缓冲 (秒)',
            description: '最大音频缓冲区大小',
            min: 1,
            default: 30,
            component: 'InputNumber'
          },
          asrFinalTextWaitMs: {
            type: 'number',
            label: '最终文本等待时间 (ms)',
            description: '等待最终文本输出的时间',
            min: 0,
            default: 1200,
            component: 'InputNumber'
          },

          // WebSocket 连接保活 / 重连参数（高级）
          wsPingIntervalMs: {
            type: 'number',
            label: 'Ping 间隔 (ms)',
            description: '定期发送 WS ping 的间隔；0 或空表示不启用',
            min: 0,
            default: 30000,
            component: 'InputNumber'
          },
          wsPongTimeoutMs: {
            type: 'number',
            label: 'Pong 超时 (ms)',
            description: '未收到 pong 时的超时断开时间',
            min: 0,
            default: 10000,
            component: 'InputNumber'
          },
          wsReconnectDelayMs: {
            type: 'number',
            label: '重连基础延迟 (ms)',
            description: '重连延迟基数（会按次数线性增加，并有上限）',
            min: 0,
            default: 2000,
            component: 'InputNumber'
          },
          wsMaxReconnectAttempts: {
            type: 'number',
            label: '最大重连次数',
            description: 'WS 非正常关闭时允许重连的最大次数',
            min: 0,
            default: 5,
            component: 'InputNumber'
          }
        }
      }
    });
  }
}

