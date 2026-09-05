/**
 * 运行时全局引导（须在 AgentRuntime / 插件加载前 import 一次）
 * - PluginBase / msgSegment：见 docs/runtime-surface.md
 * - 插件请 import PluginBase 基类；消息段用裸名 msgSegment
 */
import PluginBase from '#infrastructure/plugins/plugin-base.js';
import { msgSegment } from '#utils/msg-segment.js';
import { setRuntimeGlobal } from '#utils/runtime-globals.js';

setRuntimeGlobal('PluginBase', PluginBase);
setRuntimeGlobal('msgSegment', msgSegment);
