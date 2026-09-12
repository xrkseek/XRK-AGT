import pino from 'pino'
import chalk from 'chalk'
import runtimeConfig from './config/config.js'
import path from 'node:path'
import util from 'node:util'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
// @ts-expect-error node-schedule 无官方类型
import schedule from 'node-schedule'
import { createStream } from 'rotating-file-stream'
import paths from '#utils/paths.js'
import { normalizeError } from '#utils/normalize-error.js'
import { fixWindowsUTF8 } from '#utils/win-utf8.js'
import { setRuntimeGlobal, getRuntimeGlobal } from '#utils/runtime-globals.js'

/**
 * Logger 配置常量
 */
const LOGGER_CONFIG = {
  MAIN_LOG_PREFIX: 'app',
  TRACE_LOG_PREFIX: 'trace',
  ROTATION_INTERVAL: '1d',
  CLEANUP_TIME: '0 3 * * *',
  DEFAULT_MAX_DAYS: 3,
  DEFAULT_TRACE_DAYS: 1
}

/**
 * 颜色方案配置
 */
const COLOR_SCHEMES = {
  default: ['#3494E6', '#3498db', '#00b4d8', '#0077b6', '#023e8a'],
  scheme1: ['#FF0000', '#FF7F00', '#FFFF00', '#00FF00', '#0000FF'],
  scheme2: ['#FF69B4', '#FF1493', '#C71585', '#DB7093', '#FFC0CB'],
  scheme3: ['#00CED1', '#20B2AA', '#48D1CC', '#008B8B', '#5F9EA0'],
  scheme4: ['#8A2BE2', '#9370DB', '#7B68EE', '#6A5ACD', '#483D8B'],
  scheme5: ['#36D1DC', '#5B86E5', '#4776E6', '#8E54E9', '#6A82FB'],
  scheme6: ['#FF512F', '#F09819', '#FF8008', '#FD746C', '#FE9A8B'],
  scheme7: ['#11998e', '#38ef7d', '#56ab2f', '#a8e063', '#76b852']
}

const TIMESTAMP_SCHEMES = {
  default: ['#64B5F6', '#90CAF9', '#BBDEFB', '#E3F2FD', '#B3E5FC'],
  scheme1: ['#FFCCBC', '#FFAB91', '#FF8A65', '#FF7043', '#FF5722'],
  scheme2: ['#F8BBD0', '#F48FB1', '#F06292', '#EC407A', '#E91E63'],
  scheme3: ['#B2DFDB', '#80CBC4', '#4DB6AC', '#26A69A', '#009688'],
  scheme4: ['#D1C4E9', '#B39DDB', '#9575CD', '#7E57C2', '#673AB7'],
  scheme5: ['#90CAF9', '#64B5F6', '#42A5F5', '#2196F3', '#1E88E5'],
  scheme6: ['#FFAB91', '#FF8A65', '#FF7043', '#FF5722', '#F4511E'],
  scheme7: ['#A5D6A7', '#81C784', '#66BB6A', '#4CAF50', '#43A047']
}

/**
 * 日志级别样式配置
 */
const LOG_STYLES = {
  trace: { symbol: '•', color: 'grey', level: 10 },
  debug: { symbol: '⚙', color: 'cyan', level: 20 },
  info: { symbol: 'ℹ', color: 'blue', level: 30 },
  warn: { symbol: '⚠', color: 'yellow', level: 40 },
  error: { symbol: '✗', color: 'red', level: 50 },
  fatal: { symbol: '☠', color: 'redBright', level: 60 },
  mark: { symbol: '✧', color: 'magenta', level: 30 },
  success: { symbol: '✓', color: 'green', level: 30 },
  tip: { symbol: '💡', color: 'yellow', level: 30 },
  done: { symbol: '✓', color: 'greenBright', level: 30 }
}

type LogLevel = keyof typeof LOG_STYLES
type ColorSchemeName = keyof typeof COLOR_SCHEMES
type TimestampSchemeName = keyof typeof TIMESTAMP_SCHEMES
type PinoLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
type LogStyle = (typeof LOG_STYLES)[LogLevel]
type ChalkColorFn = (text: unknown) => string

type RotatingStream = {
  write: (chunk: string) => unknown
  end: (cb?: () => void) => void
}

type ScheduleJob = {
  cancel: () => unknown
}

type StatusName =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'blocked'
  | 'skipped'

export type RuntimeLogger = {
  trace: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  fatal: (...args: unknown[]) => void
  mark: (...args: unknown[]) => void
  chalk: typeof chalk
  red: ChalkColorFn
  green: ChalkColorFn
  yellow: ChalkColorFn
  blue: ChalkColorFn
  magenta: ChalkColorFn
  cyan: ChalkColorFn
  gray: ChalkColorFn
  white: ChalkColorFn
  xrkagtGradient: (text: string) => string
  rainbow: (text: string) => string
  gradient: (text: string, colors?: readonly string[]) => string
  success: (...args: unknown[]) => void
  warning: (...args: unknown[]) => void
  tip: (...args: unknown[]) => void
  time: (label?: string) => void
  timeEnd: (label?: string) => void
  done: (text?: string, label?: string) => void
  title: (text: string, color?: string) => void
  subtitle: (text: string, color?: string) => void
  line: (char?: string, length?: number, color?: string) => void
  box: (text: string, color?: string) => void
  json: (obj: unknown, title?: string) => void
  progress: (current: number, total: number, length?: number) => void
  important: (text: string) => void
  highlight: (text: string) => void
  fail: (text: string) => void
  system: (text: string) => void
  list: (items: unknown[], title?: string) => void
  status: (message: string, status: string, statusColor?: string) => void
  tag: (text: string, tag: string, tagColor?: string) => void
  table: (data: unknown, title?: string) => void
  gradientLine: (char?: string, length?: number) => void
  platform: () => Record<string, unknown>
  cleanLogs: (days?: number, includeTrace?: boolean) => Promise<number>
  shutdown: () => Promise<void>
  child: (bindings?: Record<string, unknown>) => RuntimeLogger
  __xrkSetLogDone?: boolean
}

function isTestStub(): boolean {
  return process.env.XRK_TEST === '1'
}

const errorCtor = Error as ErrorConstructor & { isError(value: unknown): value is Error }
const ErrorIsError = errorCtor.isError.bind(errorCtor)

function isLogLevel(level: string): level is LogLevel {
  return Object.hasOwn(LOG_STYLES, level)
}

function styleOf(level: string): LogStyle {
  return isLogLevel(level) ? LOG_STYLES[level] : LOG_STYLES.info
}

function toPinoLevel(level: string): PinoLevel {
  if (level === 'mark' || level === 'success' || level === 'tip' || level === 'done') return 'info'
  if (level === 'trace' || level === 'debug' || level === 'info' || level === 'warn' || level === 'error' || level === 'fatal') {
    return level
  }
  return 'info'
}

function schemeColors(name: unknown): string[] {
  if (typeof name === 'string' && Object.hasOwn(COLOR_SCHEMES, name)) {
    return COLOR_SCHEMES[name as ColorSchemeName]
  }
  return COLOR_SCHEMES.default
}

function timestampColors(name: unknown): string[] {
  if (typeof name === 'string' && Object.hasOwn(TIMESTAMP_SCHEMES, name)) {
    return TIMESTAMP_SCHEMES[name as TimestampSchemeName]
  }
  return TIMESTAMP_SCHEMES.default
}

function chalkPaint(color: string, text: string): string {
  type ChalkFn = (s: string) => string
  type ChalkLike = Record<string, ChalkFn | unknown>
  const fn = (chalk as unknown as ChalkLike)[color]
  return typeof fn === 'function' ? fn(text) : text
}

/**
 * 初始化日志系统
 * @returns {Object} 全局 logger 对象
 */
export default function setLog() {
  const existing = getRuntimeGlobal<RuntimeLogger>('logger')
  if (existing?.__xrkSetLogDone) {
    return existing
  }

  fixWindowsUTF8()

  const logDir = paths.logs || path.join(process.cwd(), 'logs')
  const logCfg = runtimeConfig.agt?.logging || {}
  const selectedScheme = schemeColors(logCfg.color)
  const selectedTimestampColors = timestampColors(logCfg.color)

  const fileStream = createRotatingStream(logDir, LOGGER_CONFIG.MAIN_LOG_PREFIX, logCfg.maxDays || LOGGER_CONFIG.DEFAULT_MAX_DAYS)
  const traceStream = createRotatingStream(logDir, LOGGER_CONFIG.TRACE_LOG_PREFIX, logCfg.traceDays || LOGGER_CONFIG.DEFAULT_TRACE_DAYS)

  const pinoLogger = pino(
    {
      level: 'trace',
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: {
        level: (label: string) => ({ level: label })
      }
    },
    pino.multistream([
      { stream: fileStream, level: 'debug' },
      { stream: traceStream, level: 'trace' }
    ])
  )

  const timers = new Map<string, number>()
  let cleanupJob: ScheduleJob | null = null

  const canLog = (level: string) => {
    const configLevel = runtimeConfig.agt?.logging?.level || 'info'
    const targetLevel = styleOf(level).level
    const configLevelValue = styleOf(String(configLevel)).level
    return targetLevel >= configLevelValue
  }

  /**
   * 创建渐变文本
   * @param {string} text - 文本内容
   * @param {Array<string>} colors - 颜色数组
   * @returns {string} 渐变色文本
   */
  function createGradientText(text: string, colors: readonly string[] = selectedScheme) {
    if (!text || text.length === 0) return text
    let result = ''
    const step = Math.max(1, Math.ceil(text.length / colors.length))

    for (let i = 0; i < text.length; i++) {
      const colorIndex = Math.floor(i / step) % colors.length
      result += chalk.hex(colors[colorIndex])(text[i])
    }
    return result
  }

  /**
   * 格式化时间戳
   * @returns {string} 格式化的时间戳
   */
  function formatTimestamp() {
    const now = new Date()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    const seconds = String(now.getSeconds()).padStart(2, '0')
    const timestamp = `[${month}-${day} ${hours}:${minutes}:${seconds}]`

    return createGradientText(timestamp, selectedTimestampColors)
  }

  /**
   * 获取日志头部
   * @returns {string} 日志头部文本
   */
  function getLogHeader() {
    const headerText = runtimeConfig.agt?.logging?.align ? `[${runtimeConfig.agt.logging.align}]` : '[XRKAGT]'
    return createGradientText(headerText)
  }

  /**
   * 创建日志前缀
   * @param {string} level - 日志级别
   * @returns {string} 完整的日志前缀
   */
  function createLogPrefix(level: string) {
    const style = styleOf(level)
    const header = getLogHeader()
    const timestamp = formatTimestamp()
    const symbol = chalkPaint(style.color, style.symbol)
    return `${header} ${timestamp} ${symbol} `
  }

  /**
   * 移除 ANSI 颜色代码
   * @param {string} str - 原始字符串
   * @returns {string} 清理后的字符串
   */
  function stripColors(str: unknown): string {
    if (typeof str !== 'string') return String(str)
    return str
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\u001b\[[^m]*m/g, '')
      .replace(/\[38;5;\d+m/g, '')
      .replace(/\[39m/g, '')
      .replace(/\[\d+m/g, '')
  }

  /**
   * 确保 UTF-8 编码
   * @param {string} str - 原始字符串
   * @returns {string} UTF-8 编码的字符串
   */
  function ensureUTF8(str: unknown): string {
    if (typeof str !== 'string') return String(str)
    try {
      return Buffer.from(str, 'utf8').toString('utf8')
    } catch {
      return str
    }
  }

  /**
   * 格式化持续时间
   * @param {number} duration - 持续时间（毫秒）
   * @returns {string} 格式化的时间字符串
   */
  function formatDuration(duration: number) {
    if (duration < 1000) return `${duration}ms`
    if (duration < 60000) return `${(duration / 1000).toFixed(3)}s`
    const minutes = Math.floor(duration / 60000)
    const seconds = ((duration % 60000) / 1000).toFixed(3)
    return `${minutes}m ${seconds}s`
  }

  /**
   * 创建标准日志方法
   * @param {string} level - 日志级别
   * @returns {Function} 日志方法
   */
  function createLogMethod(level: LogLevel) {
    return function (...args: unknown[]) {
      const prefix = createLogPrefix(level)
      const message = args
        .map((arg) => {
          if (typeof arg === 'object' && !ErrorIsError(arg)) {
            return util.inspect(arg, { colors: false, depth: null, maxArrayLength: null })
          }
          return String(ensureUTF8(String(arg)))
        })
        .join(' ')

      const consoleMessage = prefix + message
      if (canLog(level)) {
        console.log(consoleMessage)
      }

      const fileMessage = String(stripColors(message))
      const pinoLevel = toPinoLevel(level)

      if (ErrorIsError(args[0])) {
        pinoLogger[pinoLevel]({ err: args[0] }, fileMessage)
      } else {
        pinoLogger[pinoLevel](fileMessage)
      }
    }
  }

  const logger: RuntimeLogger = {
    trace: createLogMethod('trace'),
    debug: createLogMethod('debug'),
    info: createLogMethod('info'),
    warn: createLogMethod('warn'),
    error: createLogMethod('error'),
    fatal: createLogMethod('fatal'),
    mark: createLogMethod('mark'),

    chalk,
    red: (text) => chalk.red(text),
    green: (text) => chalk.green(text),
    yellow: (text) => chalk.yellow(text),
    blue: (text) => chalk.blue(text),
    magenta: (text) => chalk.magenta(text),
    cyan: (text) => chalk.cyan(text),
    gray: (text) => chalk.gray(text),
    white: (text) => chalk.white(text),

    xrkagtGradient: (text) => createGradientText(text, selectedScheme),
    rainbow: (text) => {
      const rainbowColors = ['#FF0000', '#FF7F00', '#FFFF00', '#00FF00', '#0000FF', '#4B0082', '#9400D3']
      return createGradientText(text, rainbowColors)
    },
    gradient: createGradientText,

    success: function (...args: unknown[]) {
      const prefix = createLogPrefix('success')
      const message = args
        .map((arg) => (typeof arg === 'string' ? String(ensureUTF8(arg)) : util.inspect(arg, { colors: false })))
        .join(' ')

      const consoleMessage = prefix + chalk.green(message)
      if (canLog('success')) {
        console.log(consoleMessage)
      }

      pinoLogger.info(String(stripColors(message)))
    },

    warning: function (...args: unknown[]) {
      this.warn(...args)
    },

    tip: function (...args: unknown[]) {
      const prefix = createLogPrefix('tip')
      const message = args
        .map((arg) => (typeof arg === 'string' ? String(ensureUTF8(arg)) : util.inspect(arg, { colors: false })))
        .join(' ')

      const consoleMessage = prefix + chalk.yellow(message)
      if (canLog('tip')) {
        console.log(consoleMessage)
      }

      pinoLogger.info(String(stripColors(message)))
    },

    /**
     * 计时器开始
     * @param {string} label - 计时器标签
     */
    time: function (label: string = 'default') {
      timers.set(label, Date.now())
    },

    /**
     * 计时器结束
     * @param {string} label - 计时器标签
     */
    timeEnd: function (label: string = 'default') {
      if (timers.has(label)) {
        const started = timers.get(label) ?? Date.now()
        const duration = Date.now() - started
        const timeStr = formatDuration(duration)
        const prefix = createLogPrefix('info')
        const message = `Timer ended ${chalk.cyan(label)}: ${chalk.yellow(timeStr)}`
        if (canLog('info')) {
          console.log(prefix + message)
        }

        pinoLogger.info(`Timer ended [${label}]: ${timeStr}`)
        timers.delete(label)
      } else {
        this.warn(`Timer ${label} does not exist`)
      }
    },

    /**
     * 完成日志
     * @param {string} text - 完成消息
     * @param {string} label - 计时器标签
     */
    done: function (text?: string, label?: string) {
      const prefix = createLogPrefix('done')
      let message = String(ensureUTF8(text || 'Operation completed'))

      if (label && timers.has(label)) {
        const started = timers.get(label) ?? Date.now()
        const duration = Date.now() - started
        const timeStr = formatDuration(duration)
        message += ` (Duration: ${chalk.yellow(timeStr)})`
        timers.delete(label)
        pinoLogger.trace(`Operation completed [${label}]: ${text} - Duration ${timeStr}`)
      }

      const consoleMessage = prefix + chalk.green(message)
      if (canLog('done')) {
        console.log(consoleMessage)
      }

      pinoLogger.info(String(stripColors(message)))
    },

    /**
     * 标题日志
     * @param {string} text - 标题文本
     * @param {string} color - 颜色
     */
    title: function (text: string, color: string = 'yellow') {
      const prefix = createLogPrefix('info')
      const processedText = String(ensureUTF8(text))
      const line = '═'.repeat(processedText.length + 10)

      if (canLog('info')) {
        console.log(prefix + chalkPaint(color, line))
        console.log(prefix + chalkPaint(color, `╔ ${processedText} ╗`))
        console.log(prefix + chalkPaint(color, line))
      }

      pinoLogger.info(`=== ${processedText} ===`)
    },

    /**
     * 子标题日志
     * @param {string} text - 子标题文本
     * @param {string} color - 颜色
     */
    subtitle: function (text: string, color: string = 'cyan') {
      const prefix = createLogPrefix('info')
      const processedText = String(ensureUTF8(text))

      if (canLog('info')) {
        console.log(prefix + chalkPaint(color, `┌─── ${processedText} ───┐`))
      }

      pinoLogger.info(`--- ${processedText} ---`)
    },

    /**
     * 分隔线
     * @param {string} char - 分隔符字符
     * @param {number} length - 长度
     * @param {string} color - 颜色
     */
    line: function (char: string = '─', length: number = 35, color: string = 'gray') {
      const prefix = createLogPrefix('info')

      if (canLog('info')) {
        console.log(prefix + chalkPaint(color, char.repeat(length)))
      }

      pinoLogger.info(char.repeat(length))
    },

    /**
     * 方框日志
     * @param {string} text - 方框文本
     * @param {string} color - 颜色
     */
    box: function (text: string, color: string = 'blue') {
      const prefix = createLogPrefix('info')
      const processedText = String(ensureUTF8(text))
      const padding = 2
      const paddedText = ' '.repeat(padding) + processedText + ' '.repeat(padding)
      const line = '─'.repeat(paddedText.length)

      if (canLog('info')) {
        console.log(prefix + chalkPaint(color, `┌${line}┐`))
        console.log(prefix + chalkPaint(color, `│${paddedText}│`))
        console.log(prefix + chalkPaint(color, `└${line}┘`))
      }

      pinoLogger.info(`Box: ${processedText}`)
    },

    /**
     * JSON 日志
     * @param {Object} obj - JSON 对象
     * @param {string} title - 标题
     */
    json: function (obj: unknown, title?: string) {
      const prefix = createLogPrefix('info')

      if (title) {
        const processedTitle = ensureUTF8(title)
        if (canLog('info')) {
          console.log(prefix + chalk.cyan(`==== ${processedTitle} ====`))
        }
      }

      try {
        const formatted = JSON.stringify(obj, null, 2)
        if (canLog('info')) {
          const lines = formatted.split('\n')
          lines.forEach((line) => {
            console.log(prefix + chalk.gray(line))
          })
        }
        pinoLogger.info({ data: obj }, title ? `JSON Data [${title}]` : 'JSON Data')
      } catch (err) {
        if (canLog('info')) {
          console.log(prefix + `Cannot serialize object: ${normalizeError(err).message}`)
          console.log(prefix + util.inspect(obj, { depth: null, colors: true }))
        }
        pinoLogger.error({ err }, 'JSON serialization failed')
      }
    },

    /**
     * 进度条
     * @param {number} current - 当前进度
     * @param {number} total - 总数
     * @param {number} length - 进度条长度
     */
    progress: function (current: number, total: number, length: number = 30) {
      const prefix = createLogPrefix('info')
      const percent = Math.min(Math.round((current / total) * 100), 100)
      const filledLength = Math.round((current / total) * length)
      const bar = '█'.repeat(filledLength) + '░'.repeat(length - filledLength)
      const message = `${chalk.cyan('[')}${chalk.green(bar)}${chalk.cyan(']')} ${chalk.yellow(percent + '%')} ${current}/${total}`

      if (canLog('info')) {
        console.log(`${prefix}${message}`)
      }

      if (percent === 100 || percent % 25 === 0) {
        pinoLogger.trace(`Progress: ${percent}% (${current}/${total})`)
      }
    },

    /**
     * 重要日志
     * @param {string} text - 重要消息
     */
    important: function (text: string) {
      const prefix = createLogPrefix('warn')
      const processedText = ensureUTF8(text)

      if (canLog('warn')) {
        console.log(prefix + chalk.bold.yellow(processedText))
      }

      pinoLogger.warn(`IMPORTANT: ${processedText}`)
    },

    /**
     * 高亮日志
     * @param {string} text - 高亮文本
     */
    highlight: function (text: string) {
      const prefix = createLogPrefix('info')
      const processedText = ensureUTF8(text)

      if (canLog('info')) {
        console.log(prefix + chalk.bgYellow.black(processedText))
      }

      pinoLogger.info(`HIGHLIGHT: ${processedText}`)
    },

    /**
     * 失败日志
     * @param {string} text - 失败消息
     */
    fail: function (text: string) {
      const prefix = createLogPrefix('error')
      const processedText = ensureUTF8(text)

      if (canLog('error')) {
        console.log(prefix + chalk.red(processedText))
      }

      pinoLogger.error(`FAIL: ${processedText}`)
    },

    /**
     * 系统日志
     * @param {string} text - 系统消息
     */
    system: function (text: string) {
      const prefix = createLogPrefix('info')
      const processedText = ensureUTF8(text)

      if (canLog('info')) {
        console.log(prefix + chalk.gray(processedText))
      }

      pinoLogger.trace(`System: ${processedText}`)
    },

    /**
     * 列表日志
     * @param {Array} items - 列表项
     * @param {string} title - 标题
     */
    list: function (items: unknown[], title?: string) {
      const prefix = createLogPrefix('info')

      if (title) {
        const processedTitle = String(ensureUTF8(title))
        if (canLog('info')) {
          console.log(prefix + chalk.cyan(`=== ${processedTitle} ===`))
        }
        pinoLogger.info(`List: ${processedTitle}`)
      }

      items.forEach((item, index) => {
        const processedItem = ensureUTF8(item)
        const bullet = chalk.gray(`  ${index + 1}.`)
        if (canLog('info')) {
          console.log(prefix + `${bullet} ${processedItem}`)
        }
        pinoLogger.info(`  ${index + 1}. ${processedItem}`)
      })
    },

    /**
     * 状态日志
     * @param {string} message - 消息
     * @param {string} status - 状态
     * @param {string} statusColor - 状态颜色
     */
    status: function (message: string, status: string, statusColor: string = 'green') {
      const prefix = createLogPrefix('info')
      const statusIcons: Record<StatusName, string> = {
        success: '✓',
        error: '✗',
        warning: '⚠',
        info: 'ℹ',
        pending: '⏳',
        running: '⚙',
        complete: '✓',
        failed: '✗',
        blocked: '⛔',
        skipped: '↷'
      }
      const key = status.toLowerCase() as StatusName
      const icon = statusIcons[key] || '•'
      const processedMessage = String(ensureUTF8(message))
      const statusMessage = chalkPaint(statusColor, `${icon} [${status.toUpperCase()}] `) + processedMessage

      if (canLog('info')) {
        console.log(prefix + statusMessage)
      }

      pinoLogger.trace(`Status Change: [${status.toUpperCase()}] ${processedMessage}`)
    },

    /**
     * 标签日志
     * @param {string} text - 文本
     * @param {string} tag - 标签
     * @param {string} tagColor - 标签颜色
     */
    tag: function (text: string, tag: string, tagColor: string = 'blue') {
      const prefix = createLogPrefix('info')
      const processedText = String(ensureUTF8(text))
      const processedTag = String(ensureUTF8(tag))
      const taggedMessage = chalkPaint(tagColor, `[${processedTag}] `) + processedText

      if (canLog('info')) {
        console.log(prefix + taggedMessage)
      }

      pinoLogger.info(`[${processedTag}] ${processedText}`)
    },

    /**
     * 表格日志
     * @param {Object} data - 表格数据
     * @param {string} title - 标题
     */
    table: function (data: unknown, title?: string) {
      const prefix = createLogPrefix('info')

      if (title) {
        const processedTitle = ensureUTF8(title)
        if (canLog('info')) {
          console.log(prefix + chalk.cyan(`=== ${processedTitle} ===`))
        }
      }

      if (typeof console.table === 'function' && data && typeof data === 'object') {
        if (canLog('info')) {
          console.table(data)
        }
        pinoLogger.trace({ data }, title ? `Table Data [${title}]` : 'Table Data')
      } else {
        this.json(data, title)
      }
    },

    /**
     * 渐变分隔线
     * @param {string} char - 分隔符字符
     * @param {number} length - 长度
     */
    gradientLine: function (char: string = '─', length: number = 50) {
      const prefix = createLogPrefix('info')
      const gradientLineText = this.gradient(char.repeat(length))

      if (canLog('info')) {
        console.log(prefix + gradientLineText)
      }

      pinoLogger.info(char.repeat(length))
    },

    /**
     * 获取平台信息
     * @returns {Object} 平台信息
     */
    platform: function () {
      return {
        os: process.platform,
        loggerType: 'pino',
        loggerVersion: '9.x',
        nodeVersion: process.version,
        logLevel: runtimeConfig.agt?.logging?.level || 'info',
        logDir: paths.logs || path.join(process.cwd(), 'logs'),
        cleanupSchedule: 'Daily at 3 AM',
        mainLogAge: `${runtimeConfig.agt?.logging?.maxDays || LOGGER_CONFIG.DEFAULT_MAX_DAYS} days`,
        traceLogAge: `${runtimeConfig.agt?.logging?.traceDays || LOGGER_CONFIG.DEFAULT_TRACE_DAYS} day(s)`,
        logFiles: {
          main: `${LOGGER_CONFIG.MAIN_LOG_PREFIX}.yyyy-MM-dd.log`,
          trace: `${LOGGER_CONFIG.TRACE_LOG_PREFIX}.yyyy-MM-dd.log`
        },
        performance: 'High (Pino)',
        encoding: 'UTF-8'
      }
    },

    /**
     * 手动清理日志
     * @param {number} days - 保留天数
     * @param {boolean} includeTrace - 是否包含 trace 日志
     * @returns {Promise<number>} 删除的文件数
     */
    cleanLogs: async function (days?: number, includeTrace: boolean = true) {
      return await cleanExpiredLogs(this, days, includeTrace)
    },

    child: function (bindings: Record<string, unknown> = {}) {
      const childPino = pinoLogger.child(bindings)
      const wrap = (level: LogLevel) => (...args: unknown[]) => {
        const prefix = createLogPrefix(level)
        const message = args
          .map((arg) => {
            if (typeof arg === 'object' && !ErrorIsError(arg)) {
              return util.inspect(arg, { colors: false, depth: null, maxArrayLength: null })
            }
            return ensureUTF8(String(arg))
          })
          .join(' ')
        if (canLog(level)) {
          console.log(prefix + message)
        }
        const fileMessage = String(stripColors(message))
        const pinoLevel = toPinoLevel(level)
        if (ErrorIsError(args[0])) {
          childPino[pinoLevel]({ err: args[0], ...bindings }, fileMessage)
        } else {
          childPino[pinoLevel](fileMessage)
        }
      }
      const childLogger: RuntimeLogger = {
        ...this,
        trace: wrap('trace'),
        debug: wrap('debug'),
        info: wrap('info'),
        warn: wrap('warn'),
        error: wrap('error'),
        fatal: wrap('fatal'),
        mark: wrap('mark'),
        child: (next) => this.child({ ...bindings, ...(next || {}) }),
      }
      return childLogger
    },

    /**
     * 关闭日志系统
     * @returns {Promise<void>}
     */
    shutdown: async function () {
      try {
        if (cleanupJob) {
          cleanupJob.cancel()
          cleanupJob = null
        }

        await new Promise<void>((resolve) => {
          fileStream.end(() => {
            traceStream.end(() => {
              resolve()
            })
          })
        })

        this.debug('Logger shutdown completed')
      } catch (err) {
        console.error('Error during logger shutdown:', err)
      }
    }
  }

  if (!isTestStub()) {
    cleanupJob = schedule.scheduleJob(LOGGER_CONFIG.CLEANUP_TIME, async () => {
      await cleanExpiredLogs(logger)
    })

    setTimeout(() => {
      cleanExpiredLogs(logger).catch(() => {})
    }, 5000)

    process.on('exit', () => {
      if (cleanupJob) {
        cleanupJob.cancel()
      }
      try {
        if (fileStream && typeof fileStream.end === 'function') {
          fileStream.end()
        }
        if (traceStream && typeof traceStream.end === 'function') {
          traceStream.end()
        }
      } catch {}
    })
  }
  // SIGINT/SIGTERM 由 loader.js ProcessManager 统一处理；此处勿注册，避免与 readline 争抢导致 Ctrl+C 需按两次

  setRuntimeGlobal('logger', logger);
  logger.__xrkSetLogDone = true

  return logger
}


/**
 * 创建日志轮转流
 * @param {string} logDir - 日志目录路径
 * @param {string} prefix - 文件前缀
 * @param {number} maxDays - 最大保留天数
 * @returns {WritableStream} 轮转流
 */
function createRotatingStream(logDir: string, prefix: string, maxDays: number): RotatingStream {
  return createStream(
    (time?: Date | number) => {
      if (!time) return `${prefix}.log`
      const date = (time instanceof Date ? time : new Date(time)).toISOString().split('T')[0]
      return `${prefix}.${date}.log`
    },
    {
      interval: LOGGER_CONFIG.ROTATION_INTERVAL,
      path: logDir,
      maxFiles: maxDays || LOGGER_CONFIG.DEFAULT_MAX_DAYS,
      compress: false
    }
  )
}

/**
 * 清理过期日志文件
 * @param {Object} logger - Logger 实例
 * @param {number} [customDays] - 自定义保留天数（可选）
 * @param {boolean} [includeTrace=true] - 是否包含 trace 日志
 * @returns {Promise<number>} 删除的文件数
 */
async function cleanExpiredLogs(logger: RuntimeLogger | undefined, customDays?: number, includeTrace: boolean = true) {
  const logDir = paths.logs || path.join(process.cwd(), 'logs')
  const mainLogMaxAge = customDays || runtimeConfig.agt?.logging?.maxDays || LOGGER_CONFIG.DEFAULT_MAX_DAYS
  const traceLogMaxAge = runtimeConfig.agt?.logging?.traceDays || LOGGER_CONFIG.DEFAULT_TRACE_DAYS
  const now = Date.now()

  try {
    const files = await fsPromises.readdir(logDir)
    let deletedCount = 0

    for (const file of files) {
      const filePath = path.join(logDir, file)
      const stats = await fsPromises.stat(filePath)

      // 跳过非日志文件（只处理 .log 文件）
      if (!file.endsWith('.log')) continue

      // 删除冗余的 .log.txt 文件（旧代码遗留）
      if (file.endsWith('.log.txt')) {
        try {
          await fsPromises.unlink(filePath)
          deletedCount++
          if (logger) {
            logger.debug(`Deleted redundant log file: ${file}`)
          }
          continue
        } catch (err) {
          const error = normalizeError(err)
          if (logger) {
            logger.error(`Failed to delete redundant log file: ${file}`, error.message)
          }
          continue
        }
      }

      // 处理正常的日志文件
      let maxAgeMs
      if (file.startsWith(`${LOGGER_CONFIG.TRACE_LOG_PREFIX}.`)) {
        if (!includeTrace) continue
        maxAgeMs = traceLogMaxAge * 24 * 60 * 60 * 1000
      } else if (file === 'bootstrap.log' || file === 'restart.log') {
        // bootstrap.log 和 restart.log 保留更长时间（默认7天）
        maxAgeMs = 7 * 24 * 60 * 60 * 1000
      } else {
        maxAgeMs = mainLogMaxAge * 24 * 60 * 60 * 1000
      }

      if (now - stats.mtime.getTime() > maxAgeMs) {
        try {
          await fsPromises.unlink(filePath)
          deletedCount++
        } catch (err) {
          const error = normalizeError(err)
          if (logger) {
            logger.error(`Failed to delete log file: ${file}`, error.message)
          }
        }
      }
    }

    if (deletedCount > 0 && logger) {
      logger.debug(`Cleaned ${deletedCount} expired/redundant log files`)
    }
    return deletedCount
  } catch (err) {
    const error = normalizeError(err)
    if (logger) {
      logger.error('Error cleaning expired logs:', error.message)
    }
    return 0
  }
}