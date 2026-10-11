/**
 * ASR 工厂：按 provider 创建客户端（默认 volcengine）
 * @see docs/factory.md §2 ASRFactory
 */
import VolcengineASRClient from './VolcengineASRClient.js'
import BaseFactory, { type ProviderFactoryFn } from '../BaseFactory.js'

const createVolcengineAsr: ProviderFactoryFn = (deviceId, config = {}, AgentRuntime) =>
  new VolcengineASRClient(
    String(deviceId ?? ''),
    (config ?? {}) as ConstructorParameters<typeof VolcengineASRClient>[1],
    AgentRuntime as ConstructorParameters<typeof VolcengineASRClient>[2],
  )

export default BaseFactory.createMediaFactoryClass({
  factoryName: 'ASR',
  defaultProvider: 'volcengine',
  disabledMessage: 'ASR未启用',
  unsupportedMessage: (provider) => `不支持的ASR提供商: ${provider}`,
  providers: new Map([['volcengine', createVolcengineAsr]]),
})
