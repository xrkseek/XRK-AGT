import ConfigBase from '#infrastructure/commonconfig/commonconfig.js';

/**
 * 火山引擎 TTS 工厂配置管理
 * 管理火山引擎语音合成（TTS）相关配置
 * 支持前端编辑，配置文件位于 data/server_bots/{port}/volcengine_tts.yaml
 */
export default class VolcengineTTSConfig extends ConfigBase {
  [key: string]: any;
  constructor() {
    super({
      name: 'volcengine_tts',
      displayName: '火山引擎 TTS 工厂配置',
      description: '火山引擎文本转语音（TTS）配置',
      filePath: (runtimeConfig: any) => {
        const port = runtimeConfig?.port ?? runtimeConfig?._port;
        if (!port) {
          throw new Error(`VolcengineTTSConfig: 未提供端口，无法解析路径`);
        }
        return `data/server_bots/${port}/volcengine_tts.yaml`;
      },
      fileType: 'yaml',
      schema: {
        fields: {
          // WebSocket 连接配置
          wsUrl: {
            type: 'string',
            label: 'WebSocket 地址',
            description: '火山引擎 TTS WebSocket 服务地址（V3双向流式接口：wss://openspeech.bytedance.com/api/v3/tts/bidirection）',
            default: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
            component: 'Input',
            layout: 'full'
          },
          apiKey: {
            type: 'string',
            label: 'API Key（新控制台）',
            description: '新版控制台鉴权：仅填此项（X-Api-Key）。填了则忽略 App ID / Access Token',
            default: '',
            component: 'InputPassword',
            layout: 'full'
          },
          appKey: {
            type: 'string',
            label: 'App ID（旧控制台）',
            description: '旧控制台 APP ID（X-Api-App-Key）',
            default: '',
            component: 'Input',
            layout: 'half'
          },
          accessKey: {
            type: 'string',
            label: 'Access Token（旧控制台）',
            description: '旧控制台 Access Token（X-Api-Access-Key）',
            default: '',
            component: 'InputPassword',
            layout: 'half'
          },
          resourceId: {
            type: 'string',
            label: '资源 ID',
            description: '火山引擎 TTS 资源 ID（用于V3双向流式接口，必须与音色类型匹配，否则会报错"resource ID is mismatched with speaker related resource"。常见值：seed-tts-2.0 或其他，请根据音色在控制台查看对应的resourceId）',
            default: 'seed-tts-2.0',
            component: 'Input',
            layout: 'half'
          },
          
          // 语音参数配置
          voiceType: {
            type: 'string',
            label: '音色类型',
            description: 'TTS 音色类型（对应文档的voice_type字段，如 zh_female_vv_uranus_bigtts），参考大模型音色列表。注意：必须与resourceId匹配，否则会报错"resource ID is mismatched with speaker related resource"',
            default: 'zh_female_vv_uranus_bigtts',
            component: 'Input',
            layout: 'half'
          },
          encoding: {
            type: 'string',
            label: '音频编码',
            description: '音频编码格式（对应文档的encoding字段：pcm、mp3、wav、ogg_opus），注意：wav不支持流式',
            enum: ['pcm', 'mp3', 'wav', 'ogg_opus'],
            default: 'pcm',
            component: 'Select',
            layout: 'half'
          },
          sampleRate: {
            type: 'number',
            label: '采样率',
            description: '音频采样率（对应文档的rate字段，单位Hz，默认24000，可选8000、16000）',
            enum: [8000, 16000, 24000],
            default: 16000,
            component: 'Select',
            layout: 'half'
          },
          
          // 语音效果配置
          speechRate: {
            type: 'number',
            label: '语速',
            description: '语音播放速度（V3双向流式接口：-500 到 500，对应V1接口的speed_ratio范围0.1-2）',
            min: -500,
            max: 500,
            default: 5,
            component: 'InputNumber',
            layout: 'half'
          },
          loudnessRate: {
            type: 'number',
            label: '音量',
            description: '语音音量（V3双向流式接口：-500 到 500，对应V1接口的loudness_ratio范围0.5-2）',
            min: -500,
            max: 500,
            default: 0,
            component: 'InputNumber',
            layout: 'half'
          },
          emotion: {
            type: 'string',
            label: '音色情感',
            description: '音色情感（对应文档的 emotion 字段，如 happy、sad、angry 等），仅部分音色支持设置情感，详见大模型音色列表-多情感音色；不确定时可先用 happy/neutral 测试',
            enum: ['happy', 'sad', 'neutral', 'angry', 'surprise'],
            default: 'happy',
            component: 'Select',
            layout: 'half'
          },
          
          // 分片配置
          chunkMs: {
            type: 'number',
            label: '分片时长 (ms)',
            description: '音频分片时长（毫秒）',
            min: 1,
            default: 128,
            component: 'InputNumber',
            layout: 'half'
          },
          chunkDelayMs: {
            type: 'number',
            label: '分片延迟 (ms)',
            description: '分片之间的延迟时间（毫秒）',
            min: 0,
            default: 0,
            component: 'InputNumber',
            layout: 'half'
          }
        }
      }
    });
  }
}

