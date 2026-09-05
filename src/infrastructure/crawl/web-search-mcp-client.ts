/**
 * Streamable HTTP MCP 客户端 — Parallel Search MCP 等免费通道
 * 移植自 parallel-mcp-search.runtime.ts
 */
import { randomUUID } from 'node:crypto'
import { withTrustedWebSearchEndpoint } from './web-search-endpoint.js'

const MCP_PROTOCOL_VERSION = '2025-06-18'

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mcpHeaders(params: { sessionId?: string; protocolVersion?: string }) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  }
  if (params.sessionId) headers['Mcp-Session-Id'] = params.sessionId
  if (params.protocolVersion) headers['MCP-Protocol-Version'] = params.protocolVersion
  return headers
}

export function iterMcpMessages(text: string) {
  const out: Record<string, any>[] = []
  const emit = (payload: unknown) => {
    if (Array.isArray(payload)) {
      for (const entry of payload) {
        if (isRecord(entry)) out.push(entry)
      }
    } else if (isRecord(payload)) {
      out.push(payload)
    }
  }

  const body = (text ?? '').trim()
  if (!body) return out
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      emit(JSON.parse(body))
    } catch {
      /* non-json */
    }
    return out
  }

  let dataLines: string[] = []
  const flush = () => {
    if (dataLines.length === 0) return
    try {
      emit(JSON.parse(dataLines.join('\n')))
    } catch {
      /* skip bad sse event */
    }
    dataLines = []
  }

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    } else if (line.trim() === '') {
      flush()
    }
  }
  flush()
  return out
}

export function selectMcpEnvelope(text: string, requestId: string) {
  let fallback: Record<string, any> = {}
  for (const msg of iterMcpMessages(text)) {
    if (!('result' in msg || 'error' in msg)) continue
    if (msg.id === requestId) return msg
    fallback = msg
  }
  return fallback
}

export function extractMcpToolPayload(envelope: Record<string, any>) {
  if ('error' in envelope) {
    throw new Error(`MCP error: ${JSON.stringify(envelope.error).slice(0, 500)}`)
  }
  const result = isRecord(envelope.result) ? envelope.result : {}
  if (result.isError) {
    throw new Error(`MCP tool error: ${JSON.stringify(result).slice(0, 500)}`)
  }
  if (isRecord(result.structuredContent)) return result.structuredContent
  const content = Array.isArray(result.content) ? result.content : []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text) {
      try {
        const parsed = JSON.parse(block.text)
        if (isRecord(parsed)) return parsed
      } catch {
        /* next block */
      }
    }
  }
  throw new Error(`MCP returned no parseable content: ${JSON.stringify(result).slice(0, 500)}`)
}

async function postMcp(
  url: string,
  params: {
    timeoutSeconds?: number
    signal?: AbortSignal
    sessionId?: string
    protocolVersion?: string
    body: Record<string, any>
  }
) {
  return withTrustedWebSearchEndpoint(
    {
      url,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      init: {
        method: 'POST',
        headers: mcpHeaders({
          sessionId: params.sessionId,
          protocolVersion: params.protocolVersion
        }),
        body: JSON.stringify(params.body)
      }
    },
    async (response: Response) => ({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text: await response.text(),
      sessionIdHeader: response.headers.get('mcp-session-id')
    })
  )
}

/**
 * MCP initialize → notifications/initialized → tools/call
 */
export async function callMcpTool(params: {
  url: string
  toolName: string
  toolArgs: Record<string, any>
  timeoutSeconds?: number
  signal?: AbortSignal
  clientName?: string
  clientVersion?: string
}) {
  const timeoutSeconds = params.timeoutSeconds ?? 30
  const clientName = params.clientName ?? 'xrk-agt'
  const clientVersion = params.clientVersion ?? '1.0'

  const initId = randomUUID()
  const init = await postMcp(params.url, {
    timeoutSeconds,
    signal: params.signal,
    body: {
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: clientVersion }
      }
    }
  })
  if (!init.ok) {
    throw new Error(`MCP initialize failed (${init.status}): ${init.text || init.statusText}`)
  }

  const sessionId = init.sessionIdHeader ?? undefined
  const initEnvelope = selectMcpEnvelope(init.text, initId)
  const negotiatedVersion =
    (isRecord(initEnvelope.result) && typeof initEnvelope.result.protocolVersion === 'string'
      ? initEnvelope.result.protocolVersion
      : undefined) ?? MCP_PROTOCOL_VERSION

  await postMcp(params.url, {
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    sessionId,
    protocolVersion: negotiatedVersion,
    timeoutSeconds,
    signal: params.signal
  })

  const callId = randomUUID()
  const call = await postMcp(params.url, {
    body: {
      jsonrpc: '2.0',
      id: callId,
      method: 'tools/call',
      params: { name: params.toolName, arguments: params.toolArgs }
    },
    sessionId,
    protocolVersion: negotiatedVersion,
    timeoutSeconds,
    signal: params.signal
  })
  if (!call.ok) {
    throw new Error(`MCP tools/call failed (${call.status}): ${call.text || call.statusText}`)
  }
  return extractMcpToolPayload(selectMcpEnvelope(call.text, callId))
}
