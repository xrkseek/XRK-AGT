import EnhancerBase from '#infrastructure/plugins/enhancer-base.js'

/**
 * OPQBot 事件增强
 */
export default class OPQEnhancer extends EnhancerBase {
  constructor() {
    super({
      name: 'OPQBot',
      dsc: 'OPQBot 事件增强与日志统一',
      event: 'opqbot.*',
      tasker: 'opqbot',
      priority: 100
    })
  }

  enhanceEvent(e) {
    super.enhanceEvent(e)
    this.bindBotEntities(e)
  }
}
