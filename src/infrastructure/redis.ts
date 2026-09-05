import runtimeConfig from './config/config.js'
import common, { normalizeHost } from '#utils/common.js'
import { normalizeError } from '#utils/normalize-error.js'
import { connectWithRetry } from '#utils/db-connect-utils.js'
import RuntimeUtil from '#utils/runtime-util.js'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from 'redis'
import { setRuntimeGlobal } from '#utils/runtime-globals.js'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENSURE_REDIS_MJS = path.join(PROJECT_ROOT, 'scripts', 'ensure-redis.mjs')

type RedisClient = any

let globalClient: RedisClient | null = null

const REDIS_CONFIG = {
  MAX_RETRIES: 3,
  CONNECT_TIMEOUT: 10000,
  MAX_COMMAND_QUEUE: 5000,
  MIN_POOL_SIZE: 3,
  MAX_POOL_SIZE: 50,
  RECONNECT_BASE_DELAY: 1000,
  RECONNECT_MAX_DELAY: 30000,
  HEALTH_CHECK_INTERVAL: 30000
}

export default async function redisInit() {
  if (globalClient?.isOpen) return globalClient

  const fastStart = process.env.XRK_FAST_START === '1'
  const maxRetries = fastStart ? 1 : REDIS_CONFIG.MAX_RETRIES
  const redisUrl = buildRedisUrl((runtimeConfig as any).redis)
  const clientConfig = buildClientConfig(redisUrl, fastStart)

  const client = await connectWithRetry({
    label: 'Redis',
    maxRetries,
    fastStart,
    connectionUrl: redisUrl,
    createClient: () => createClient(clientConfig as any) as any,
    onBeforeRetry: attemptRedisStart,
    devHint:
      '本机拉起: node scripts/ensure-redis.mjs  |  Windows: net start Memurai / net start Redis  |  Unix: redis-server --daemonize yes'
  })

  registerEventHandlers(client)
  startHealthCheck(client)

  globalClient = client
  setRuntimeGlobal('redis', client)
  return client
}

function buildRedisUrl(redisConfig: Record<string, any> | undefined) {
  const username = redisConfig?.username || ''
  const password = redisConfig?.password || ''
  const host = normalizeHost(redisConfig?.host || '127.0.0.1', 'redis')
  const port = redisConfig?.port || 6379
  const db = redisConfig?.db || 0
  const auth = username || password ? `${username}${password ? `:${password}` : ''}@` : ''
  return `redis://${auth}${host}:${port}/${db}`
}

function buildClientConfig(redisUrl: string, fastStart = false) {
  const options = (runtimeConfig as any).redis?.options || {}
  const connectTimeout = fastStart
    ? 2000
    : (options.connectTimeout ?? REDIS_CONFIG.CONNECT_TIMEOUT)
  return {
    url: redisUrl,
    socket: {
      reconnectStrategy: createReconnectStrategy(),
      connectTimeout
    },
    connectionPoolSize: getOptimalPoolSize(),
    commandsQueueMaxLength: REDIS_CONFIG.MAX_COMMAND_QUEUE
  }
}

function createReconnectStrategy() {
  return (retries: number) => {
    const delay = Math.min(
      Math.pow(2, retries) * REDIS_CONFIG.RECONNECT_BASE_DELAY,
      REDIS_CONFIG.RECONNECT_MAX_DELAY
    )
    return delay
  }
}

function getOptimalPoolSize() {
  const cpuCount = os.cpus().length
  const memoryGB = os.totalmem() / 1024 ** 3
  const basePoolSize = Math.ceil(cpuCount * 3)

  const memoryLimit = memoryGB < 2 ? 5 : memoryGB < 4 ? 10 : memoryGB < 8 ? 20 : Infinity
  const poolSize = Math.min(basePoolSize, memoryLimit)

  const finalSize = Math.max(
    REDIS_CONFIG.MIN_POOL_SIZE,
    Math.min(poolSize, REDIS_CONFIG.MAX_POOL_SIZE)
  )

  RuntimeUtil.makeLog(
    'debug',
    `系统资源: CPU=${cpuCount}核, 内存=${memoryGB.toFixed(2)}GB, 连接池大小=${finalSize}`,
    'Redis'
  )
  return finalSize
}

function isLoopbackHost(host: unknown) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0'
}

async function attemptRedisStart(retryCount: number) {
  if (process.env.NODE_ENV === 'production') return

  const host = (runtimeConfig as any).redis?.host || '127.0.0.1'
  const port = (runtimeConfig as any).redis?.port || 6379
  if (!isLoopbackHost(host)) {
    RuntimeUtil.makeLog('debug', `非本机 Redis（${host}），跳过本地拉起`, 'Redis')
    return
  }

  try {
    RuntimeUtil.makeLog('info', '尝试启动本地 Redis...', 'Redis')
    const { ensureRedisReady } = await import(pathToFileURL(ENSURE_REDIS_MJS).href)
    const result = await ensureRedisReady({ host, port })
    if (!result.ok) {
      throw new Error(result.reason || 'ensure-redis 失败')
    }
    await common.sleep(500 + retryCount * 500)
  } catch (err) {
    const error = normalizeError(err)
    RuntimeUtil.makeLog('debug', `启动失败: ${error.message}`, 'Redis')
  }
}

let healthCheckTimer: ReturnType<typeof setInterval> | null = null

function registerEventHandlers(client: any) {
  // 勿在 error 里再手动 connect：与 socket reconnectStrategy 双重重连会打架刷 console
  client.on('error', (err: any) => {
    RuntimeUtil.makeLog('warn', normalizeError(err).message, 'Redis')
  })
  client.on('ready', () => RuntimeUtil.makeLog('debug', '就绪', 'Redis'))
  client.on('reconnecting', () => RuntimeUtil.makeLog('debug', '正在重新连接...', 'Redis'))
  client.on('end', () => RuntimeUtil.makeLog('warn', '连接已关闭', 'Redis'))
}

function startHealthCheck(client: any) {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
  healthCheckTimer = setInterval(async () => {
    if (!client.isOpen) return
    try {
      await client.ping()
    } catch (err) {
      RuntimeUtil.makeLog('debug', `健康检查失败: ${normalizeError(err).message}`, 'Redis')
    }
  }, REDIS_CONFIG.HEALTH_CHECK_INTERVAL)
  healthCheckTimer.unref?.()
}

export async function closeRedis() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
  if (!globalClient?.isOpen) return

  globalClient.removeAllListeners('end')

  try {
    await globalClient.quit()
  } catch {
    try {
      await globalClient.disconnect()
    } catch {
      /* ignore */
    }
  }
}

export function getRedisClient() {
  return globalClient
}
