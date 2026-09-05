/**
 * Monitor Service — Agent 执行追踪（内存环形缓冲）
 * Token/步骤写入供 /metrics.workflow 摘要；不做完整 APM。
 */
import EventEmitter from 'node:events'
import { normalizeError } from '#utils/normalize-error.js'

type TraceTokens = { input: number; output: number; total: number }

type ExecutionTrace = {
  id: string
  agentId?: unknown
  workflow?: unknown
  userId?: unknown
  startTime: number
  endTime: number | null
  duration?: number
  steps: Array<Record<string, unknown>>
  toolsCalled: unknown[]
  errors: Array<{ traceId: string; message: string; timestamp: number }>
  tokensUsed: TraceTokens
  cost: number
  status: string
  resultError?: unknown
  responsePreview?: string
}

export class MonitorService extends EventEmitter {
  executionTraces = new Map<string, ExecutionTrace>()
  _traceOrder: string[] = []
  _traceHead = 0
  errorLogs: Array<{ traceId: string; message: string; timestamp: number }> = []
  maxTraces = 10000
  maxErrors = 1000

  startTrace(traceId: string, context: Record<string, any> = {}) {
    const trace: ExecutionTrace = {
      id: traceId,
      agentId: context.agentId,
      workflow: context.workflow,
      userId: context.userId,
      startTime: Date.now(),
      endTime: null,
      steps: [],
      toolsCalled: [],
      errors: [],
      tokensUsed: { input: 0, output: 0, total: 0 },
      cost: 0,
      status: 'running'
    }

    this.executionTraces.set(traceId, trace)
    this._traceOrder.push(traceId)

    while (this.executionTraces.size > this.maxTraces) {
      const oldestId = this._traceOrder[this._traceHead++]
      if (!oldestId) break
      this.executionTraces.delete(oldestId)
    }

    if (this._traceHead > 1000 && this._traceHead * 2 > this._traceOrder.length) {
      this._traceOrder = this._traceOrder.slice(this._traceHead)
      this._traceHead = 0
    }

    this.emit('trace:started', { traceId, trace })
    return traceId
  }

  addStep(traceId: string, step: Record<string, unknown>) {
    const trace = this.executionTraces.get(traceId)
    if (!trace) return
    trace.steps.push({ ...step, timestamp: Date.now() })
  }

  recordTokens(traceId: string, tokens: { input?: number; output?: number }) {
    const trace = this.executionTraces.get(traceId)
    if (!trace) return
    trace.tokensUsed.input += tokens.input || 0
    trace.tokensUsed.output += tokens.output || 0
    trace.tokensUsed.total += (tokens.input || 0) + (tokens.output || 0)
  }

  recordError(traceId: string, error: unknown) {
    const trace = this.executionTraces.get(traceId)
    const entry = {
      traceId,
      message: normalizeError(error ?? 'unknown').message,
      timestamp: Date.now()
    }
    if (trace) trace.errors.push(entry)
    this.errorLogs.push(entry)
    if (this.errorLogs.length > this.maxErrors) this.errorLogs.shift()
    this.emit('error:recorded', { traceId, error: entry })
  }

  endTrace(traceId: string, result: Record<string, any> = {}) {
    const trace = this.executionTraces.get(traceId)
    if (!trace) return
    trace.endTime = Date.now()
    trace.duration = trace.endTime - trace.startTime
    trace.status = result.success === false ? 'failed' : 'completed'
    if (result.error) trace.resultError = result.error
    if (result.response) trace.responsePreview = String(result.response).slice(0, 200)
    this.emit('trace:ended', { traceId, trace })
  }

  getTraceSummary() {
    const traces = Array.from(this.executionTraces.values())
    const completed = traces.filter((t) => t.status === 'completed')
    const failed = traces.filter((t) => t.status === 'failed')
    const running = traces.filter((t) => t.status === 'running')
    return {
      traces: {
        total: traces.length,
        completed: completed.length,
        failed: failed.length,
        running: running.length
      },
      avgDurationMs:
        completed.length > 0
          ? Math.round(completed.reduce((sum, t) => sum + (t.duration || 0), 0) / completed.length)
          : 0,
      recentErrors: this.errorLogs.slice(-5).map((e) => ({
        traceId: e.traceId,
        message: e.message,
        timestamp: e.timestamp
      }))
    }
  }

  reset() {
    this.executionTraces.clear()
    this._traceOrder = []
    this._traceHead = 0
    this.errorLogs = []
    this.removeAllListeners()
  }
}

export default new MonitorService()
