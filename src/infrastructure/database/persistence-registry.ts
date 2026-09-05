/**
 * 可选持久化探活注册表（薄 SPI）
 *
 * Runtime 拥有 Redis + SQLite；Mongo/PG/Qdrant 等由 Core 自管连接，
 * 仅在此注册 ping，供 `/api/health.services.persistence` 展示。
 * 可选存储全挂不会单独打成 unhealthy。
 */

export type PersistenceKind =
  | 'redis'
  | 'sqlite'
  | 'document'
  | 'relational'
  | 'vector'
  | 'embedded'
  | 'other'

export type PersistenceProvider = {
  id: string
  kind?: PersistenceKind
  /** 为 true 且探活失败时整体 status=degraded */
  required?: boolean
  /** 所属 Core 名，如 mongodb-Core */
  core?: string
  ping: () => boolean | Promise<boolean>
  close?: () => void | Promise<void>
  meta?: Record<string, unknown>
}

type StoreProbe = {
  status: string
  kind: string
  required: boolean
  core?: string
  error?: string
}

/** 跨存储一致性边界（常量，非运行时强制） */
export const PERSISTENCE_POLICY = Object.freeze({
  redis: 'runtime-required',
  sqlite: 'runtime-embedded',
  optionalCores: 'soft-skip',
  crossStore: 'eventual-consistency-only',
  unitOfWork: 'none-across-engines'
})

const providers = new Map<string, PersistenceProvider>()

export function registerPersistenceProvider(provider: PersistenceProvider): void {
  if (!provider?.id || typeof provider.ping !== 'function') {
    throw new TypeError('registerPersistenceProvider 需要 { id, ping }')
  }
  providers.set(String(provider.id), {
    required: false,
    kind: 'other',
    ...provider,
    id: String(provider.id)
  })
}

export function unregisterPersistenceProvider(id: string): void {
  providers.delete(String(id))
}

/** 测试 / 热重载清理 */
export function clearPersistenceProviders(): void {
  providers.clear()
}

export function listPersistenceProviders(): PersistenceProvider[] {
  return [...providers.values()]
}

/**
 * 探活全部已注册可选存储（永不抛）
 */
export async function probePersistenceProviders(): Promise<{
  status: 'operational' | 'degraded' | 'unavailable' | 'idle'
  policy: typeof PERSISTENCE_POLICY
  stores: Record<string, StoreProbe>
}> {
  const stores: Record<string, StoreProbe> = {}
  if (providers.size === 0) {
    return { status: 'idle', policy: PERSISTENCE_POLICY, stores }
  }

  await Promise.all(
    [...providers.values()].map(async (p) => {
      try {
        const ok = await p.ping()
        stores[p.id] = {
          status: ok ? 'operational' : 'unavailable',
          kind: p.kind || 'other',
          required: !!p.required,
          ...(p.core ? { core: p.core } : {})
        }
      } catch (err) {
        stores[p.id] = {
          status: 'unavailable',
          kind: p.kind || 'other',
          required: !!p.required,
          ...(p.core ? { core: p.core } : {}),
          error: err instanceof Error ? err.message : String(err)
        }
      }
    })
  )

  const values = Object.values(stores)
  const anyUp = values.some((v) => v.status === 'operational')
  const anyRequiredDown = values.some((v) => v.required && v.status !== 'operational')
  let status: 'operational' | 'degraded' | 'unavailable' | 'idle' = 'unavailable'
  if (anyRequiredDown) status = 'degraded'
  else if (anyUp && values.every((v) => v.status === 'operational')) status = 'operational'
  else if (anyUp) status = 'degraded'

  return { status, policy: PERSISTENCE_POLICY, stores }
}
