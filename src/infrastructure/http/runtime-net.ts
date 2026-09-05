/**
 * 服务器网络/配置访问辅助（host/url/代理、公网 IP、启动地址展示）
 * 从 AgentRuntime 拆出，供 listen/proxy/boot 与 facade 共用。
 *
 * 展示基址以 yaml 为准：server.server.url → 公网（misc.detectPublicIP）→ 127.0.0.1
 */
import chalk from 'chalk'
import RuntimeUtil from '#utils/runtime-util.js'
import runtimeConfig from '#infrastructure/config/config.js'

type RuntimeLike = {
  proxyEnabled?: boolean
  wwwMountPaths?: string[]
  _cache: { get: (key: string) => any; set: (key: string, value: any) => void }
}

export function getServerHost() {
  const host = (runtimeConfig as any)?.server?.server?.host
  return typeof host === 'string' && host.trim() ? host.trim() : '0.0.0.0'
}

export function getConfiguredServerUrl() {
  const configuredUrl = (runtimeConfig as any)?.server?.server?.url
  return typeof configuredUrl === 'string' ? configuredUrl.trim() : ''
}

export function getProxyConfig() {
  return (runtimeConfig as any)?.server?.proxy || {}
}

export function isHttpsEnabled() {
  return (runtimeConfig as any)?.server?.https?.enabled === true
}

export function getPublicServerUrl(runtime: RuntimeLike, override = '') {
  const trimmed = typeof override === 'string' ? override.trim() : ''
  if (trimmed) {
    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `${isHttpsEnabled() ? 'https' : 'http'}://${trimmed.replace(/^\/+/, '')}`
    try {
      return new URL(withScheme).toString().replace(/\/+$/, '')
    } catch {
      return ''
    }
  }

  const proxyConfig = getProxyConfig()
  if (runtime.proxyEnabled && Array.isArray(proxyConfig.domains) && proxyConfig.domains[0]) {
    const domain = proxyConfig.domains[0]
    const protocol = domain.ssl?.enabled ? 'https' : 'http'
    return `${protocol}://${domain.domain}`.replace(/\/+$/, '')
  }

  const configuredUrl = getConfiguredServerUrl()
  if (configuredUrl) {
    const withScheme = /^https?:\/\//i.test(configuredUrl)
      ? configuredUrl
      : `${isHttpsEnabled() ? 'https' : 'http'}://${configuredUrl.replace(/^\/+/, '')}`
    try {
      return new URL(withScheme).toString().replace(/\/+$/, '')
    } catch {
      return ''
    }
  }

  return ''
}

/**
 * 将 server.url（可无 scheme）归一为带端口的展示 origin/path。
 */
function formatConfiguredDisplayUrl(protocol: string, port: number) {
  const configuredUrl = getConfiguredServerUrl()
  if (!configuredUrl) return ''

  let normalizedUrl = configuredUrl
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = `${protocol}://${normalizedUrl}`
  }

  try {
    const parsed = new URL(normalizedUrl)
    if (!parsed.port) parsed.port = String(port)
    return parsed.origin + parsed.pathname.replace(/\/$/, '')
  } catch {
    const hasPort = /:[0-9]+$/.test(normalizedUrl.split('://')[1] || '')
    return hasPort
      ? normalizedUrl.replace(/\/$/, '')
      : `${normalizedUrl.replace(/\/$/, '')}:${port}`
  }
}

/**
 * 启动展示 / Web 基址：配置 url > 公网 > 127.0.0.1
 */
function resolveAccessBase(publicIp: string | null, protocol: string, port: number) {
  const configured = formatConfiguredDisplayUrl(protocol, port)
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      return configured.replace(/\/+$/, '')
    }
  }
  if (publicIp) {
    return `${protocol}://${publicIp}:${port}`
  }
  return `${protocol}://127.0.0.1:${port}`
}

export async function displayAccessUrls(runtime: RuntimeLike, protocol: string, port: number) {
  const detectPublic = (runtimeConfig as any).server?.misc?.detectPublicIP !== false
  const publicIp = detectPublic ? await getPublicIP(runtime) : null
  const base = resolveAccessBase(publicIp, protocol, port)

  console.log(chalk.cyan('\n▶ 访问地址：'))
  console.log(`    ${chalk.cyan('•')} ${chalk.white(base)}`)

  const configuredDisplay = formatConfiguredDisplayUrl(protocol, port)
  if (configuredDisplay && configuredDisplay !== base && !configuredDisplay.startsWith(base)) {
    console.log(chalk.yellow('\n  配置域名：'))
    console.log(`    ${chalk.cyan('•')} ${chalk.white(configuredDisplay)}`)
  }

  const wwwPaths = Array.isArray(runtime.wwwMountPaths) ? runtime.wwwMountPaths : []
  if (wwwPaths.length) {
    const norm = (mount: string) => {
      const rel = String(mount).replace(/\/$/, '') || ''
      return rel.startsWith('/') ? `${rel}/` : `/${rel}/`
    }
    const pathList = wwwPaths.map(norm)
    const systemPaths = pathList.filter((p) => p === '/xrk/')
    const otherPaths = pathList.filter((p) => p !== '/xrk/').sort((a, b) => a.localeCompare(b))

    console.log(chalk.yellow('\n  Web 控制台：'))
    console.log(`    ${chalk.gray('基址')} ${chalk.white(base)}`)
    if (systemPaths.length) {
      console.log(`    ${chalk.gray('系统')} ${chalk.white(systemPaths.join('  '))}`)
    }
    if (otherPaths.length) {
      console.log(`    ${chalk.gray('其它')} ${chalk.white(otherPaths.join('  '))}`)
    }
    console.log(chalk.gray('    路径拼在基址后打开；顶栏粘贴 API 密钥'))
  }
}

/**
 * 网络信息（兼容旧 API）。不再枚举局域网网卡；仅按 yaml 探测公网。
 */
export async function getLocalIpAddress(runtime: RuntimeLike) {
  const cacheKey = 'local_ip_addresses'
  const cached = runtime._cache.get(cacheKey)
  if (cached) return cached

  const result: { local: any[]; public: string | null; primary: null } = {
    local: [],
    public: null,
    primary: null
  }
  try {
    if ((runtimeConfig as any).server?.misc?.detectPublicIP !== false) {
      result.public = await getPublicIP(runtime)
    }
    runtime._cache.set(cacheKey, result)
    return result
  } catch (err: any) {
    RuntimeUtil.makeLog('debug', `获取IP地址失败：${err.message}`, '服务器')
    return result
  }
}

function isValidIP(ip: string) {
  if (!ip) return false
  return /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/.test(ip)
}

async function getPublicIP(runtime?: RuntimeLike | null) {
  const cacheKey = 'public_ip_only'
  if (runtime?._cache) {
    const hit = runtime._cache.get(cacheKey)
    if (hit !== undefined) return hit
  }

  const apis =
    Array.isArray((runtimeConfig as any).server?.misc?.publicIpApis) &&
    (runtimeConfig as any).server.misc.publicIpApis.length
      ? (runtimeConfig as any).server.misc.publicIpApis
      : [
          'https://ifconfig.me/ip',
          'https://api.ipify.org',
          'https://icanhazip.com',
          'https://ipinfo.io/ip'
        ]
  const timeoutMs = Number((runtimeConfig as any).server?.misc?.publicIpTimeoutMs) || 3000

  let found: string | null = null
  for (const apiUrl of apis) {
    try {
      const response = await fetch(apiUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'text/plain, */*'
        }
      })
      if (response.ok) {
        const ip = (await response.text()).trim()
        if (ip && isValidIP(ip)) {
          found = ip
          break
        }
      }
    } catch {
      continue
    }
  }

  if (!found) {
    RuntimeUtil.makeLog('debug', '获取公网IP失败，所有API均不可用', '服务器')
  }
  if (runtime?._cache) runtime._cache.set(cacheKey, found)
  return found
}
