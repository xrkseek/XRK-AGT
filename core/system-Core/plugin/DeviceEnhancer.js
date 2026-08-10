import EnhancerBase from '#infrastructure/plugins/enhancer-base.js'
import { EventNormalizer } from '#utils/event-normalizer.js'

/**
 * Device 事件增强：补齐 isDevice / 私聊形态 / 日志
 */
export default class DeviceEnhancer extends EnhancerBase {
  constructor() {
    super({
      name: 'Device',
      dsc: '设备事件属性补齐与日志标准化',
      event: 'device.*',
      tasker: 'device',
      priority: 100
    })
  }

  enhanceEvent(e) {
    super.enhanceEvent(e)
    EventNormalizer.normalizeDevice(e)
  }
}
