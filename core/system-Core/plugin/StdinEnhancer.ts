import EnhancerBase from '#infrastructure/plugins/enhancer-base.js'
import { EventNormalizer } from '#utils/event-normalizer.js'

/**
 * STDIN / API 事件增强（api 别名在 resolveTaskerId 中归一为 stdin）
 */
export default class StdinEnhancer extends EnhancerBase {
  [key: string]: any;
  constructor() {
    super({
      name: 'STDIN',
      dsc: 'STDIN/API 事件统一补齐',
      event: 'stdin.*',
      tasker: 'stdin',
      priority: 100
    })
  }

  enhanceEvent(e: any) {
    super.enhanceEvent(e)
    EventNormalizer.normalizeStdin(e)
  }
}
