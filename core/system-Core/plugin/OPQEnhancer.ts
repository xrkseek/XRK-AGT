import EnhancerBase from '#infrastructure/plugins/enhancer-base.js'

/**
 * OPQBot 事件增强
 */
export default class OPQEnhancer extends EnhancerBase {
  [key: string]: any;
  constructor() {
    super({
      name: 'OPQBot',
      dsc: 'OPQBot 事件增强与日志统一',
      event: 'opqbot.*',
      tasker: 'opqbot',
      priority: 100
    })
  }

  enhanceEvent(e: any) {
    super.enhanceEvent(e)
    this.bindBotEntities(e)
  }
}
