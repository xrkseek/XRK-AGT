/**
 * 跨平台系统指标（HTTP 概览 / #状态 共用）
 * 一律走 systeminformation + os；不 shell 采数。
 */
import os from 'node:os'
import si from 'systeminformation'

const MIN_DISK_BYTES = 1 * 1024 * 1024 * 1024
const PSEUDO_FS_RE = /^(tmpfs|overlay|devtmpfs|squashfs|ramfs|aufs|fuse\.|proc|sysfs|cgroup)/i
const PSEUDO_MOUNT_RE = /^\/(dev|proc|sys|run|snap)(\/|$)/i

function isRootMount(mount: string) {
  const m = String(mount || '')
  return m === '/' || m === 'C:\\' || /^[A-Za-z]:\\?$/.test(m)
}

/** 滤掉伪/过小卷，根分区优先，否则按容量降序 */
export function normalizeDisks(raw: any[]) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((d) => {
      const size = Number(d.size || 0)
      const used = Number(d.used || 0)
      const reported = Number(d.use)
      const use =
        Number.isFinite(reported) && reported > 0
          ? reported
          : size > 0
            ? +((used / size) * 100).toFixed(2)
            : 0
      return {
        fs: String(d.fs || d.type || d.mount || 'disk'),
        mount: String(d.mount || d.fs || ''),
        size,
        used,
        use
      }
    })
    .filter((d) => d.size > 0)

  const useful = list.filter(
    (d) =>
      d.size >= MIN_DISK_BYTES && !PSEUDO_MOUNT_RE.test(d.mount) && !PSEUDO_FS_RE.test(d.fs)
  )
  const pool = useful.length ? useful : list
  pool.sort((a, b) => {
    if (isRootMount(a.mount) !== isRootMount(b.mount)) return isRootMount(a.mount) ? -1 : 1
    return b.size - a.size
  })
  return pool
}

export async function readDisks() {
  return normalizeDisks(await si.fsSize().catch(() => []))
}

/**
 * 内存：优先 available（Linux/mac 准确「可用」），否则 free
 */
export async function readMem() {
  const m = await si.mem().catch(() => null)
  if (m && (m as any).total > 0) {
    const total = Number((m as any).total)
    const available = Number((m as any).available > 0 ? (m as any).available : (m as any).free || 0)
    const used = Math.max(0, Math.min(total, total - available))
    return {
      total,
      used,
      free: available,
      swapTotal: Number((m as any).swaptotal || 0),
      swapUsed: Number((m as any).swapused || 0)
    }
  }
  const total = os.totalmem()
  const free = os.freemem()
  return { total, used: Math.max(0, total - free), free, swapTotal: 0, swapUsed: 0 }
}

/** 回环 / docker / Hyper-V 等；勿把 eth0/ens 仅因 virtual:true 算进来 */
const VIRTUAL_IFACE_RE = /^(lo\d*|veth|br-|docker|virbr|tun|tap|wg|isatap|teredo|vEthernet)/i

export function isSkippableNetIface(name: unknown, meta: { internal?: boolean } | null = null) {
  const iface = String(name || '')
  if (!iface) return true
  if (meta?.internal) return true
  if (/loopback/i.test(iface)) return true
  if (VIRTUAL_IFACE_RE.test(iface)) return true
  // systeminformation 在部分云主机把 eth0/ens 标成 virtual，不能据此跳过
  return false
}

/** 累加各网卡字节；跳过回环与明显虚拟口，避免 Windows vEthernet / docker 双计 */
export function sumNetworkBytes(stats: any[], skipIfaces?: Set<string> | null) {
  const skip = skipIfaces instanceof Set ? skipIfaces : null
  let rx = 0
  let tx = 0
  for (const n of Array.isArray(stats) ? stats : []) {
    const iface = String(n.iface || n.interface || '')
    if (!iface) continue
    if (skip?.has(iface)) continue
    if (isSkippableNetIface(iface)) continue
    rx += Number(n.rx_bytes || n.bytes_recv || 0)
    tx += Number(n.tx_bytes || n.bytes_sent || 0)
  }
  return { rx, tx }
}

/** 从 ifaces 元数据构建 skip 集合（仅 internal / 名字像虚拟口） */
export function buildNetworkSkipSet(ifaces: any[]) {
  const skip = new Set<string>()
  for (const i of Array.isArray(ifaces) ? ifaces : []) {
    const name = String(i?.iface || '')
    if (!name) continue
    if (isSkippableNetIface(name, i)) skip.add(name)
  }
  return skip
}

function pickFallbackNetBytes(stats: any[], ifaces: any[]) {
  const list = (Array.isArray(stats) ? stats : []).filter(
    (n) => !isSkippableNetIface(String(n?.iface || n?.interface || ''))
  )
  if (!list.length) return { rx: 0, tx: 0 }
  const defName = (Array.isArray(ifaces) ? ifaces : []).find((i) => i?.default)?.iface
  const pick =
    (defName && list.find((n) => n.iface === defName)) ||
    list.reduce((a, b) => {
      const ba = Number(a.rx_bytes || 0) + Number(a.tx_bytes || 0)
      const bb = Number(b.rx_bytes || 0) + Number(b.tx_bytes || 0)
      return bb > ba ? b : a
    })
  return {
    rx: Number(pick.rx_bytes || pick.bytes_recv || 0),
    tx: Number(pick.tx_bytes || pick.bytes_sent || 0)
  }
}

export async function readNetworkBytes() {
  const [stats, ifaces] = await Promise.all([
    si.networkStats('*').catch(() => si.networkStats().catch(() => [])),
    si.networkInterfaces().catch(() => [])
  ])
  const skip = buildNetworkSkipSet(ifaces as any[])
  const summed = sumNetworkBytes(stats as any[], skip)
  if (summed.rx > 0 || summed.tx > 0) return summed
  return pickFallbackNetBytes(stats as any[], ifaces as any[])
}

/** 一次性 CPU 占用（#状态等） */
export async function readCpuLoadPercent() {
  const load = await si.currentLoad().catch(() => null)
  if (load && Number.isFinite(load.currentLoad)) return +Number(load.currentLoad).toFixed(2)
  const cpus = load?.cpus
  if (Array.isArray(cpus) && cpus.length) {
    const avg = cpus.reduce((s, c) => s + Number((c as any).load || 0), 0) / cpus.length
    return +avg.toFixed(2)
  }
  return 0
}
