import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { wireArgs } from './format.js'
import './socket-guard.js'

// retryable: try again later with the same request_id.
// rejected: the platform said no; retrying the same request will not help.
// auth: the token is missing or expired.
export type PlatformErrorKind = 'retryable' | 'rejected' | 'auth'

export class PlatformError extends Error {
  constructor(readonly kind: PlatformErrorKind, message: string, readonly code?: string) {
    super(message)
  }
}

export interface TokenProvider {
  get(): Promise<string>
  refresh(): Promise<void>
}

export class StaticToken implements TokenProvider {
  constructor(private readonly value: string) {}
  async get() {
    return this.value
  }
  async refresh() {
    throw new PlatformError('auth', 'static token cannot be refreshed')
  }
}

export interface ListenHandlers {
  onAck(): void
  onUpdate(): void
  onToolsChanged?(): void
}

export interface Platform {
  call(tool: string, args: Record<string, unknown>): Promise<any>
  downloadAttachment(projectId: string, attachmentId: string): Promise<Uint8Array>
  // Resolves or rejects when the subscription ends; the caller reconnects.
  listen(handlers: ListenHandlers, signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

// The platform puts a stable code next to the message and says whether the
// same request is worth resending; without a code nothing is resent.
function toolError(result: any): PlatformError {
  const text = (result.content ?? []).find((c: any) => c.type === 'text')?.text ?? 'tool_failed'
  const error = result.structuredContent?.error
  return new PlatformError(error?.retryable === true ? 'retryable' : 'rejected', error?.message || text, error?.code)
}

function classify(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401 || error.code === 403) return new PlatformError('auth', 'http_' + error.code)
    if (error.code && error.code >= 400 && error.code < 500 && error.code !== 408 && error.code !== 429) {
      return new PlatformError('rejected', 'http_' + error.code)
    }
    return new PlatformError('retryable', 'http_' + (error.code ?? 'error'))
  }
  if (error instanceof McpError) {
    // JSON-RPC level errors: invalid params and unknown methods will not fix themselves.
    if (error.code === -32602 || error.code === -32601) return new PlatformError('rejected', error.message, String(error.code))
    return new PlatformError('retryable', error.message, String(error.code))
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/401|unauthorized/i.test(message)) return new PlatformError('auth', message)
  return new PlatformError('retryable', message)
}

export const READ_TOOLS = new Set(['project_get_context', 'work_list', 'task_get_context', 'collaboration_get', 'task_get_updates'])

// Refuses every write before it leaves the process. Used for connection tests
// against the real platform.
export class ReadOnlyPlatform implements Platform {
  constructor(private readonly inner: Platform) {}

  call(tool: string, args: Record<string, unknown>): Promise<any> {
    if (!READ_TOOLS.has(tool)) return Promise.reject(new PlatformError('rejected', 'read_only_mode: ' + tool))
    return this.inner.call(tool, args)
  }

  downloadAttachment(projectId: string, attachmentId: string) {
    return this.inner.downloadAttachment(projectId, attachmentId)
  }

  listen(handlers: ListenHandlers, signal: AbortSignal) {
    return this.inner.listen(handlers, signal)
  }

  close() {
    return this.inner.close()
  }
}

export class McpPlatform implements Platform {
  private client: Client | null = null
  private connecting: Promise<Client> | null = null

  constructor(
    private readonly url: string,
    private readonly resourceUri: string,
    private readonly tokens: TokenProvider,
    private readonly timeoutMs = 30_000,
    private readonly protocolVersion = '2026-07-28',
  ) {}

  private authFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', 'Bearer ' + (await this.tokens.get()))
    return fetch(input, { ...init, headers })
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: 'ai-pm-desktop', version: '0.1.0' })
        const transport = new StreamableHTTPClientTransport(new URL(this.url), { fetch: this.authFetch })
        await client.connect(transport, { timeout: this.timeoutMs })
        this.client = client
        return client
      })().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async drop() {
    const client = this.client
    this.client = null
    await client?.close().catch(() => {})
  }

  async listResources(): Promise<{ uri: string; name: string }[]> {
    const client = await this.connect()
    const resources: { uri: string; name: string }[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await client.listResources(cursor ? { cursor } : {}, { timeout: this.timeoutMs })
      resources.push(...page.resources)
      cursor = page.nextCursor
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error('平台资源分页无效')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return resources
  }

  async call(tool: string, args: Record<string, unknown>): Promise<any> {
    let result: any
    try {
      const client = await this.connect()
      result = await client.callTool({ name: tool, arguments: wireArgs(args) }, undefined, { timeout: this.timeoutMs })
    } catch (error) {
      const failure = classify(error)
      if (failure.kind !== 'rejected') await this.drop()
      throw failure
    }
    if (result.isError) throw toolError(result)
    if (result.structuredContent != null) return result.structuredContent
    const text = (result.content ?? []).find((c: any) => c.type === 'text')?.text
    if (text == null) return {}
    try {
      return JSON.parse(text)
    } catch {
      return { text }
    }
  }

  // Construct the URL from the configured platform, never a URL in task text.
  // Credentials stay in the client; redirects cannot send them elsewhere.
  async downloadAttachment(projectId: string, attachmentId: string): Promise<Uint8Array> {
    const url = new URL(this.url)
    if (!/\/mcp\/?$/.test(url.pathname)) throw new Error('MCP 地址必须以 /mcp 结尾才能下载附件')
    url.pathname = url.pathname.replace(/\/mcp\/?$/, '') + `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`
    url.search = ''
    url.hash = ''
    const init: RequestInit = { redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) }
    let response = await this.authFetch(url, init)
    if (response.status === 401) {
      await response.body?.cancel()
      await this.tokens.refresh()
      response = await this.authFetch(url, init)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new PlatformError(response.status === 401 ? 'auth' : response.status >= 500 || response.status === 429 ? 'retryable' : 'rejected', `附件下载失败（HTTP ${response.status}）：${attachmentId}`)
    }
    const limit = 10 * 1024 * 1024
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel()
      throw new Error('附件超过 10 MB：' + attachmentId)
    }
    if (!response.body) throw new Error('附件响应为空：' + attachmentId)
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > limit) throw new Error('附件超过 10 MB：' + attachmentId)
        chunks.push(part.value)
      }
      return Buffer.concat(chunks, length)
    } finally {
      await reader.cancel().catch(() => {})
    }
  }

  // The platform's work subscription is a long-lived POST answered with an SSE stream.
  async listen(handlers: ListenHandlers, signal: AbortSignal): Promise<void> {
    const message = {
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'subscriptions/listen',
      params: { notifications: { resourceSubscriptions: [this.resourceUri] } },
      _meta: { 'io.modelcontextprotocol/protocolVersion': this.protocolVersion },
    }
    let response: Response
    try {
      response = await this.authFetch(this.url, {
        method: 'POST',
        body: JSON.stringify(message),
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
        signal,
      })
    } catch (error) {
      throw classify(error)
    }
    if (response.status === 401 || response.status === 403) throw new PlatformError('auth', 'http_' + response.status)
    if (!response.ok || !response.body) throw new PlatformError('retryable', 'subscription_http_' + response.status)
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      throw new PlatformError('retryable', 'subscription_not_event_stream')
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let acknowledged = false
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) throw new PlatformError('retryable', 'subscription_closed')
        buffer += value.replace(/\r\n/g, '\n')
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
          if (!data) continue
          const event = JSON.parse(data)
          if (event.method === 'notifications/subscriptions/acknowledged') {
            const uris: string[] = event.params?.notifications?.resourceSubscriptions ?? []
            if (!uris.includes(this.resourceUri)) throw new PlatformError('rejected', 'subscription_ack_resource_mismatch')
            acknowledged = true
            handlers.onAck()
          } else if (event.method === 'notifications/resources/updated') {
            if (acknowledged && event.params?.uri === this.resourceUri) handlers.onUpdate()
          } else if (event.method === 'notifications/tools/list_changed') {
            handlers.onToolsChanged?.()
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return
      throw classify(error)
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  async close() {
    await this.drop()
  }
}
