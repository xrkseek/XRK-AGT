/**
 * 工厂基类：提供商注册与媒体工厂（ASR/TTS）同构封装
 */

export type ProviderFactoryFn = (
  deviceId?: unknown,
  config?: Record<string, unknown>,
  AgentRuntime?: unknown,
  ...rest: unknown[]
) => unknown

export type MediaFactoryConfig = Record<string, unknown> & {
  enabled?: boolean
  provider?: string
}

export default class BaseFactory {
  providers: Map<string, ProviderFactoryFn>
  factoryName: string

  constructor(providers?: Map<string, ProviderFactoryFn>, factoryName = 'Factory') {
    // 勿用 `providers = new Map()` 默认参：会跨实例共享同一 Map
    this.providers = providers ?? new Map()
    this.factoryName = factoryName
  }

  registerProvider(name: string, factoryFn: ProviderFactoryFn) {
    if (!name || typeof factoryFn !== 'function') {
      throw new Error(`注册${this.factoryName}提供商时必须提供名称和工厂函数`)
    }
    this.providers.set(String(name).toLowerCase(), factoryFn)
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys())
  }

  isProviderSupported(provider: string) {
    return this.providers.has((provider || '').toLowerCase())
  }

  getProviderFactory(provider: string) {
    return this.providers.get((provider || '').toLowerCase())
  }

  /**
   * 创建设备媒体工厂类（ASR/TTS 等同构）
   */
  static createMediaFactoryClass({
    providers,
    factoryName,
    defaultProvider,
    disabledMessage,
    unsupportedMessage
  }: {
    providers: Map<string, ProviderFactoryFn>
    factoryName: string
    defaultProvider: string
    disabledMessage: string
    unsupportedMessage: (provider: string) => string
  }) {
    const baseFactory = new BaseFactory(providers, factoryName)

    return class MediaFactory {
      static registerProvider(name: string, factoryFn: ProviderFactoryFn) {
        baseFactory.registerProvider(name, factoryFn)
      }

      static listProviders() {
        return baseFactory.listProviders()
      }

      static isProviderSupported(provider: string) {
        return baseFactory.isProviderSupported(provider)
      }

      static createClient(
        deviceId: unknown,
        config: MediaFactoryConfig = {},
        AgentRuntime?: unknown
      ) {
        if (!config.enabled) {
          throw new Error(disabledMessage)
        }

        const provider = String(config.provider || defaultProvider).toLowerCase()
        const factory = baseFactory.getProviderFactory(provider)
        if (!factory) {
          throw new Error(unsupportedMessage(provider))
        }

        return factory(deviceId, config, AgentRuntime)
      }
    }
  }
}
