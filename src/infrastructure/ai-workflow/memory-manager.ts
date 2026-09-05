/**
 * Memory Manager — 进程内短期 / 长期记忆（关键词打分召回，非向量 embedding）。
 * - 短期：AiWorkflow.storeMessageMemory / retrieveRelevantContexts
 * - 长期：system-Core `workflow/memory.js` 的 MCP 工具写入与检索
 * 主对话历史仍以 chatSessionHistory / ChatStream.messageHistory 为准。
 */

type MemoryEntry = Record<string, any> & {
  id?: string
  content?: string
  timestamp?: number
  importance?: number
  accessCount?: number
  lastAccessed?: number
}

function tokenize(text: string) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
}

/**
 * @returns 0..1 关键词重合分
 */
function keywordScore(content: unknown, query: unknown) {
  const q = String(query || '').trim()
  if (!q) return 0
  const body = String(content || '')
  if (!body) return 0
  const lower = body.toLowerCase()
  const qLower = q.toLowerCase()
  if (lower.includes(qLower)) return 1
  const terms = tokenize(q)
  if (!terms.length) return lower.includes(qLower) ? 1 : 0
  let hit = 0
  for (const t of terms) {
    if (lower.includes(t)) hit++
  }
  return hit / terms.length
}

export class MemoryManager {
  shortTermMemories = new Map<string, MemoryEntry[]>()
  longTermMemories = new Map<string, MemoryEntry[]>()
  maxShortTermSize = 50
  maxLongTermSize = 1000

  addShortTermMemory(userId: string, memory: Record<string, any>) {
    if (!this.shortTermMemories.has(userId)) {
      this.shortTermMemories.set(userId, [])
    }

    const memories = this.shortTermMemories.get(userId)!
    memories.push({
      ...memory,
      timestamp: Date.now(),
      id: `${userId}_${Date.now()}`
    })

    if (memories.length > this.maxShortTermSize) {
      memories.shift()
    }
  }

  getShortTermMemories(userId: string, limit = 10) {
    const memories = this.shortTermMemories.get(userId) || []
    return memories.slice(-limit)
  }

  /**
   * 短期记忆关键词召回（空 query 返回最近若干条；有 query 按重合分排序）。
   */
  async searchShortTermMemories(userId: string, query: string, limit = 5) {
    const memories = this.shortTermMemories.get(userId) || []
    const q = String(query || '').trim()
    if (!q) return memories.slice(-limit).reverse()
    return memories
      .map((m) => ({ ...m, _score: keywordScore(m.content, q) }))
      .filter((m) => m._score > 0)
      .sort((a, b) => b._score - a._score || (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit)
      .map(({ _score, ...rest }) => ({ ...rest, score: _score }))
  }

  /**
   * @returns 记忆 ID
   */
  async addLongTermMemory(userId: string, memory: Record<string, any>) {
    if (!this.longTermMemories.has(userId)) {
      this.longTermMemories.set(userId, [])
    }

    const memoryId = `lt_${userId}_${Date.now()}`
    const longTermMemory: MemoryEntry = {
      id: memoryId,
      userId,
      content: memory.content,
      type: memory.type || 'fact',
      metadata: memory.metadata || {},
      importance: memory.importance || 0.5,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now()
    }

    const memories = this.longTermMemories.get(userId)!
    memories.push(longTermMemory)

    if (memories.length > this.maxLongTermSize) {
      memories.sort((a, b) => (a.importance || 0) - (b.importance || 0))
      memories.shift()
    }

    return memoryId
  }

  /**
   * 长期记忆关键词检索（空 query 按重要度；有 query 先关键词分再叠重要度）。
   */
  async searchLongTermMemories(userId: string, query: string, limit = 5) {
    const memories = this.longTermMemories.get(userId) || []
    const q = String(query || '').trim()
    const scored = memories.map((m) => {
      const kw = q ? keywordScore(m.content, q) : 1
      const rank = kw * 2 + (m.importance || 0) + (m.accessCount || 0) * 0.1
      return { m, kw, rank }
    })
    const results = scored
      .filter((x) => !q || x.kw > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit)
      .map((x) => x.m)

    for (const memory of results) {
      memory.accessCount = (memory.accessCount || 0) + 1
      memory.lastAccessed = Date.now()
    }

    return results
  }

  deleteLongTermMemory(userId: string, memoryId: string) {
    const memories = this.longTermMemories.get(userId)
    if (!memories) return false

    const index = memories.findIndex((m) => m.id === memoryId)
    if (index === -1) return false

    memories.splice(index, 1)
    return true
  }
}

export default new MemoryManager()
