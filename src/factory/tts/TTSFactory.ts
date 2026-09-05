/**
 * TTS工厂类
 * 统一管理不同平台的TTS客户端创建
 * 支持扩展多个TTS服务提供商
 */

import VolcengineTTSClient from './VolcengineTTSClient.js'
import BaseFactory from '../BaseFactory.js'

export default BaseFactory.createMediaFactoryClass({
  factoryName: 'TTS',
  defaultProvider: 'volcengine',
  disabledMessage: 'TTS未启用',
  unsupportedMessage: (provider) => `不支持的TTS提供商: ${provider}`,
  providers: new Map([
    [
      'volcengine',
      (deviceId: string, config: Record<string, any>, AgentRuntime: any) =>
        new VolcengineTTSClient(deviceId, config, AgentRuntime)
    ]
  ])
})
