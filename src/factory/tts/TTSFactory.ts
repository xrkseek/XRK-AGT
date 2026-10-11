/**
 * TTS工厂类
 * 统一管理不同平台的TTS客户端创建
 * 支持扩展多个TTS服务提供商
 * @see docs/factory.md §4 TTSFactory
 */

import VolcengineTTSClient from './VolcengineTTSClient.js'
import BaseFactory, { type ProviderFactoryFn } from '../BaseFactory.js'

const createVolcengineTts: ProviderFactoryFn = (deviceId, config = {}, AgentRuntime) =>
  new VolcengineTTSClient(
    String(deviceId ?? ''),
    (config ?? {}) as ConstructorParameters<typeof VolcengineTTSClient>[1],
    AgentRuntime as ConstructorParameters<typeof VolcengineTTSClient>[2],
  )

export default BaseFactory.createMediaFactoryClass({
  factoryName: 'TTS',
  defaultProvider: 'volcengine',
  disabledMessage: 'TTS未启用',
  unsupportedMessage: (provider) => `不支持的TTS提供商: ${provider}`,
  providers: new Map([['volcengine', createVolcengineTts]]),
})
