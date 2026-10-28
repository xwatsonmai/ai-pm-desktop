// In-memory AI PM platform for tests. It speaks the same MCP-over-HTTP dialect as
// the real one, including the custom subscriptions/listen SSE stream, and supports
// fault injection. Never point tests at the production task pool.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export interface FakeTask {
  id: string
  project_id: string
  title: string
  status: string
  revision: number
  version: number
  brief: string
  acceptance_criteria: string
  kind: 'requirement' | 'bug'
  parent_requirement_id: string | null
  bug_context: { task_id: string; revision: number; version: number; branch: string; sha: string; description: string } | null
  branch: string | null
  claimant: string | null
  claim_id: string | null
  alignment: { status: string; questions?: unknown; reply?: string } | null
  submission: Record<string, unknown> | null
  deployment: Record<string, unknown> | null
  attachments?: { id: string; project_id: string; name: string; size: number; mime: string }[]
}

export interface FakeCollaboration {
  id: string
  project_id: string
  title: string
  status: string
  version: number
  claimant: string | null
  claim_id: string | null
  lease_until: number | null
  result: Record<string, unknown> | null
}

export type Fault =
  | { tool: string; kind: 'http500' } // fail before applying
  | { tool: string; kind: 'drop_response' } // apply, then fail the response
  | { tool: string; kind: 'reject'; code: string; message?: string } // a tool error that resending will not fix
  | { tool: string; kind: 'busy' } // a tool error marked retryable, before applying

export const TOKEN = 'test-token'
const CLIENT = 'desktop-client'

export class FakePlatform {
  attachments = new Map<string, { projectId: string; bytes: Uint8Array }>()
  brokenAttachments = new Set<string>()
  attachmentRequests: string[] = []
  readonly project = { id: 'prj_test', repository: '', branch: 'main' }
  resourcePages: { resources: { uri: string; name: string }[]; nextCursor?: string }[] | null = null
  readonly resourceUri = 'ai-pm://projects/prj_test/work'
  tasks = new Map<string, FakeTask>()
  collaborations = new Map<string, FakeCollaboration>()
  calls: { tool: string; args: any; outcome: string }[] = []
  faults: Fault[] = []
  notifyEnabled = true
  legacyErrors = false // answer errors as plain text only, like a platform before its idempotency release
  brokenContext = new Set<string>() // task_get_context fails with a transient error for these ids
  private receipts = new Map<string, { tool: string; args: string; result: any }>()
  private listeners = new Set<ServerResponse>()
  private server: Server | null = null
  url = ''

  constructor(repository: string, private readonly basePath = '') {
    this.project.repository = repository
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        res.writeHead(500).end(String(error))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${this.basePath}/mcp`
    return this.url
  }

  async stop() {
    for (const res of this.listeners) res.end()
    this.listeners.clear()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
    this.server?.closeAllConnections()
  }

  // ---- test controls ----

  attach(taskId: string, id: string, name: string, bytes: Uint8Array) {
    this.attachments.set(id, { projectId: this.project.id, bytes })
    const task = this.tasks.get(taskId)!
    task.attachments = [...(task.attachments ?? []), { id, project_id: this.project.id, name, size: bytes.byteLength, mime: 'application/octet-stream' }]
  }

  addTask(id: string, title = '测试需求 ' + id): FakeTask {
    const task: FakeTask = {
      id, project_id: this.project.id, title, status: 'ready', revision: 1, version: 1,
      brief: '为 ' + title + ' 实现功能', acceptance_criteria: '功能可用，测试通过',
      kind: 'requirement', parent_requirement_id: null, bug_context: null, branch: null,
      claimant: null, claim_id: null, alignment: null, submission: null, deployment: null,
    }
    this.tasks.set(id, task)
    this.changed()
    return task
  }

  addCollaboration(id: string, title = '排查 ' + id): FakeCollaboration {
    const item: FakeCollaboration = {
      id, project_id: this.project.id, title, status: 'pending', version: 1, claimant: null, claim_id: null,
      lease_until: null, result: null,
    }
    this.collaborations.set(id, item)
    this.changed()
    return item
  }

  update(id: string, fn: (task: FakeTask) => void) {
    const task = this.tasks.get(id)!
    fn(task)
    task.version += 1
    this.changed()
  }

  passTest(id: string) {
    this.update(id, (t) => (t.status = 'pending_release'))
  }

  returnToDev(id: string) {
    this.update(id, (t) => (t.status = 'doing'))
  }

  accept(id: string) {
    this.update(id, (t) => (t.status = 'done'))
  }

  cancel(id: string) {
    this.update(id, (t) => (t.status = 'canceled'))
  }

  changeRequirement(id: string) {
    this.update(id, (t) => {
      t.revision += 1
      t.brief += '（已修订）'
    })
  }

  replyAlignment(id: string, reply: string) {
    this.update(id, (t) => {
      t.status = 'ready'
      t.alignment = { ...(t.alignment ?? { status: 'pending' }), status: 'replied', reply }
    })
  }

  // A bug the product found while testing a requirement. The parent is blocked
  // in fixing until all its bugs are resolved, then waits for a retest.
  fileBug(parentId: string, id: string, title = '缺陷 ' + id): FakeTask {
    const parent = this.tasks.get(parentId)!
    const bug = this.addTask(id, title)
    bug.kind = 'bug'
    bug.parent_requirement_id = parentId
    bug.bug_context = {
      task_id: parentId, revision: parent.revision, version: parent.version, branch: parent.branch ?? '',
      sha: String(parent.submission?.sha ?? ''), description: parent.brief,
    }
    this.update(parentId, (t) => (t.status = 'fixing'))
    return bug
  }

  bugsOf(parentId: string) {
    return [...this.tasks.values()].filter((t) => t.parent_requirement_id === parentId)
  }

  verifyBug(id: string) {
    this.update(id, (t) => (t.status = 'resolved'))
    const parentId = this.tasks.get(id)!.parent_requirement_id!
    if (this.bugsOf(parentId).every((b) => ['resolved', 'closed', 'rejected', 'canceled'].includes(b.status))) {
      this.update(parentId, (t) => (t.status = 'retest'))
    }
  }

  // 修复无效：back to the developer who holds the claim; blocks the parent again.
  returnBug(id: string) {
    this.update(id, (t) => (t.status = 'doing'))
    const parentId = this.tasks.get(id)!.parent_requirement_id!
    if (this.tasks.get(parentId)!.status === 'retest') this.update(parentId, (t) => (t.status = 'fixing'))
  }

  // The product picks the version that contains every fix and retests it.
  startRetest(parentId: string, sha: string) {
    this.update(parentId, (t) => {
      t.status = 'testing'
      t.submission = { ...t.submission, sha, summary: '产品开始复测' }
    })
  }

  callsOf(tool: string) {
    return this.calls.filter((c) => c.tool === tool)
  }

  changed() {
    if (!this.notifyEnabled) return
    const event = { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: this.resourceUri } }
    for (const res of this.listeners) res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  dropListeners() {
    for (const res of this.listeners) res.destroy()
    this.listeners.clear()
  }

  // ---- HTTP ----

  // ---- OAuth (dynamic registration, authorization code + PKCE, rotating refresh tokens) ----

  tokenLifetimeSeconds = 3600
  private clients = new Map<string, { redirect_uris: string[] }>()
  private codes = new Map<string, { client_id: string; challenge: string; redirect_uri: string }>()
  private accessTokens = new Set<string>([TOKEN])
  private refreshTokens = new Map<string, string>() // refresh token → client_id
  tokenRequests: { grant_type: string; resource: string | null }[] = []

  revokeAllRefreshTokens() {
    this.refreshTokens.clear()
  }

  private issue(clientId: string) {
    const access = 'at_' + randomUUID()
    const refresh = 'rt_' + randomUUID()
    this.accessTokens.add(access)
    this.refreshTokens.set(refresh, clientId)
    return { access_token: access, token_type: 'Bearer', expires_in: this.tokenLifetimeSeconds, refresh_token: refresh, scope: 'mcp' }
  }

  private origin() {
    return new URL(this.url).origin + this.basePath
  }

  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString()
  }

  private json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(value))
  }

  private async oauth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const origin = this.origin()
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      this.json(res, 200, { resource: this.url, authorization_servers: [origin], scopes_supported: ['mcp'], bearer_methods_supported: ['header'] })
    } else if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
      this.json(res, 200, {
        issuer: origin, authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token',
        registration_endpoint: origin + '/oauth/register', response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
      })
    } else if (url.pathname === '/oauth/register' && req.method === 'POST') {
      const metadata = JSON.parse(await this.body(req))
      const clientId = 'cli_' + randomUUID().slice(0, 8)
      this.clients.set(clientId, { redirect_uris: metadata.redirect_uris })
      this.json(res, 201, { ...metadata, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) })
    } else if (url.pathname === '/oauth/authorize') {
      // Auto-approves, standing in for the user's browser login.
      const p = url.searchParams
      const client = this.clients.get(p.get('client_id') ?? '')
      if (!client || !client.redirect_uris.includes(p.get('redirect_uri') ?? '') || p.get('code_challenge_method') !== 'S256') {
        res.writeHead(400).end('bad authorize request')
        return true
      }
      const code = 'code_' + randomUUID()
      this.codes.set(code, { client_id: p.get('client_id')!, challenge: p.get('code_challenge')!, redirect_uri: p.get('redirect_uri')! })
      const target = new URL(p.get('redirect_uri')!)
      target.searchParams.set('code', code)
      if (p.get('state')) target.searchParams.set('state', p.get('state')!)
      res.writeHead(302, { Location: target.toString() }).end()
    } else if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const form = new URLSearchParams(await this.body(req))
      this.tokenRequests.push({ grant_type: form.get('grant_type') ?? '', resource: form.get('resource') })
      if (form.get('grant_type') === 'authorization_code') {
        const grant = this.codes.get(form.get('code') ?? '')
        const { createHash } = await import('node:crypto')
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
        if (!grant || grant.challenge !== challenge || grant.client_id !== form.get('client_id')) {
          this.json(res, 400, { error: 'invalid_grant' })
          return true
        }
        this.codes.delete(form.get('code')!)
        this.json(res, 200, this.issue(grant.client_id))
      } else if (form.get('grant_type') === 'refresh_token') {
        const clientId = this.refreshTokens.get(form.get('refresh_token') ?? '')
        if (!clientId) {
          this.json(res, 400, { error: 'invalid_grant' })
          return true
        }
        this.refreshTokens.delete(form.get('refresh_token')!) // rotation
        this.json(res, 200, this.issue(clientId))
      } else {
        this.json(res, 400, { error: 'unsupported_grant_type' })
      }
    } else {
      return false
    }
    return true
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (this.basePath) {
      if (!url.pathname.startsWith(this.basePath + '/')) return void res.writeHead(404).end()
      url.pathname = url.pathname.slice(this.basePath.length)
    }
    if (await this.oauth(req, res, url)) return
    const attachment = /^\/api\/projects\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && attachment) {
      const [, projectId, id] = attachment
      this.attachmentRequests.push(id)
      if (!this.accessTokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return void res.writeHead(401).end()
      if (this.brokenAttachments.has(id)) return void res.writeHead(500).end()
      const file = this.attachments.get(id)
      if (!file) return void res.writeHead(404).end()
      if (file.projectId !== projectId) return void res.writeHead(403).end()
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.bytes.byteLength })
      return void res.end(file.bytes)
    }
    if (req.method === 'GET') return void res.writeHead(405).end()
    if (req.method === 'DELETE') return void res.writeHead(200).end()
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!this.accessTokens.has(bearer)) {
      res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${this.origin()}/.well-known/oauth-protected-resource/mcp", scope="mcp"` })
      return void res.end()
    }
    const message = JSON.parse(await this.body(req))
    if (message.id === undefined) return void res.writeHead(202).end()
    const reply = (result: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    }
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: { listChanged: true }, resources: {} },
          serverInfo: { name: 'fake-ai-pm', version: '1.0.0' },
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: [] })
      case 'resources/list': {
        const pages = this.resourcePages ?? [{ resources: [{ uri: `ai-pm://projects/${this.project.id}/work`, name: '项目工作列表' }] }]
        return reply(pages[Number(message.params?.cursor ?? 0)] ?? { resources: [] })
      }
      case 'subscriptions/listen': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const uris = message.params?.notifications?.resourceSubscriptions ?? []
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications: { resourceSubscriptions: uris } } })}\n\n`)
        this.listeners.add(res)
        res.on('close', () => this.listeners.delete(res))
        return
      }
      case 'tools/call':
        return this.toolCall(message.params.name, message.params.arguments ?? {}, reply, res)
      default:
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } }))
    }
  }

  private toolCall(tool: string, args: any, reply: (r: unknown) => void, res: ServerResponse) {
    const faultIndex = this.faults.findIndex((f) => f.tool === tool)
    const fault = faultIndex >= 0 ? this.faults.splice(faultIndex, 1)[0] : null
    if (fault?.kind === 'http500') {
      this.calls.push({ tool, args, outcome: 'http500' })
      return void res.writeHead(500).end('injected')
    }
    const failure = (error: Rejection) => reply({
      isError: true,
      content: [{ type: 'text', text: error.message }],
      ...(this.legacyErrors ? {} : { structuredContent: { error: { code: error.code, message: error.message, retryable: error.retryable } } }),
    })
    if (fault?.kind === 'reject' || fault?.kind === 'busy') {
      this.calls.push({ tool, args, outcome: fault.kind === 'busy' ? 'busy' : 'rejected' })
      return failure(fault.kind === 'busy' ? new Rejection('unavailable', 'database is locked', true) : new Rejection(fault.code, fault.message ?? '平台拒绝：' + fault.code))
    }
    let result: any
    try {
      checkArgs(tool, args)
      result = this.apply(tool, args)
    } catch (error) {
      if (!(error instanceof Rejection)) throw error
      this.calls.push({ tool, args, outcome: 'rejected' })
      return failure(error)
    }
    this.calls.push({ tool, args, outcome: fault?.kind === 'drop_response' ? 'dropped' : 'ok' })
    if (fault?.kind === 'drop_response') return void res.writeHead(502).end('lost')
    // Like the real platform: results are text only.
    reply({ content: [{ type: 'text', text: JSON.stringify(result) }] })
  }

  // Idempotent on request_id: the same request returns its first result.
  private apply(tool: string, args: any): any {
    const requestId: string | undefined = args.request_id
    if (requestId) {
      const previous = this.receipts.get(requestId)
      const fingerprint = JSON.stringify(args)
      if (previous) {
        if (previous.tool !== tool || previous.args !== fingerprint) throw new Rejection('idempotency_conflict', 'request_id 已用于不同内容')
        return previous.result
      }
      // Results are snapshots, so a late replay still answers with the first state.
      const result = structuredClone(this.execute(tool, args))
      this.receipts.set(requestId, { tool, args: fingerprint, result })
      this.changed()
      return result
    }
    return this.execute(tool, args)
  }

  private task(args: any): FakeTask {
    const task = this.tasks.get(args.task_id)
    if (!task) throw new Rejection('not_found', 'task_not_found')
    return task
  }

  private claimed(args: any): FakeTask {
    const task = this.task(args)
    if (task.claimant !== CLIENT || task.claim_id !== args.claim_id) throw new Rejection('forbidden', 'claim_invalid')
    return task
  }

  private collaboration(args: any, claimed: boolean): FakeCollaboration {
    const item = this.collaborations.get(args.collaboration_id)
    if (!item) throw new Rejection('not_found', 'collaboration_not_found')
    if (claimed && (item.claimant !== CLIENT || item.claim_id !== args.claim_id)) throw new Rejection('forbidden', 'claim_invalid')
    return item
  }

  // Every write commits a new version, reports included, as on the real platform.
  private taskResult(task: FakeTask, claimId?: string) {
    task.version += 1
    return { task: { ...task, claim_id: undefined }, ...(claimId ? { claim_id: claimId } : {}) }
  }

  private collabResult(item: FakeCollaboration, claimId?: string) {
    item.version += 1
    return { collaboration: { ...item, claim_id: undefined }, ...(claimId ? { claim_id: claimId } : {}) }
  }

  private execute(tool: string, args: any): any {
    switch (tool) {
      case 'project_get_context':
        return { project: { ...this.project } }
      case 'work_list': {
        const mine = (s: { claimant: string | null }) => s.claimant === CLIENT
        // Like the real list: claimable work, plus this client's unfinished tasks.
        // A resolved bug drops out until the product returns it.
        const owned = ['doing', 'aligning', 'testing', 'fixing', 'retest', 'verifying', 'pending_release', 'review']
        return {
          tasks: [...this.tasks.values()].filter((t) => t.status === 'ready' || (mine(t) && owned.includes(t.status))).map((t) => ({ ...t, claim_id: undefined })),
          collaborations: [...this.collaborations.values()].filter((c) => c.status === 'pending' || mine(c)).map((c) => ({ ...c, claim_id: undefined })),
        }
      }
      case 'task_get_context': {
        if (this.brokenContext.has(args.task_id)) throw new Rejection('unavailable', 'database is locked', true)
        const task = this.task(args)
        return {
          task: { ...task, claim_id: undefined },
          requirement_review: { summary: task.brief },
          events: [],
          artifacts: { huge: 'x'.repeat(1000) },
          tasks: [{ id: 'other' }],
        }
      }
      case 'task_claim': {
        const task = this.task(args)
        if (task.status !== 'ready' || (task.alignment && task.alignment.status !== 'completed')) throw new Rejection('invalid_request', 'task_not_ready')
        task.status = 'doing'
        task.claimant = CLIENT
        task.claim_id = 'clm_' + randomUUID().slice(0, 8)
        task.branch = args.branch ?? null
        return this.taskResult(task, task.claim_id)
      }
      case 'task_report_work':
        return this.taskResult(this.claimed(args))
      case 'task_request_alignment': {
        const task = this.claimed(args)
        current(task, args)
        task.status = 'aligning'
        task.alignment = { status: 'pending', questions: args.questions === undefined ? [] : questions(args.questions) }
        return this.taskResult(task)
      }
      case 'task_resume_development': {
        const task = this.claimed(args)
        current(task, args)
        if (task.alignment?.status !== 'replied') throw new Rejection('invalid_request', 'alignment_not_replied')
        task.status = 'doing'
        task.alignment = { ...task.alignment, status: 'completed' }
        task.claim_id = 'clm_' + randomUUID().slice(0, 8)
        return this.taskResult(task, task.claim_id)
      }
      case 'task_submit_result': {
        const task = this.claimed(args)
        if (task.status !== 'doing') throw new Rejection('invalid_request', 'task_not_doing')
        if (Number(args.revision) !== task.revision) throw new Rejection('conflict', 'revision_mismatch')
        task.status = task.parent_requirement_id ? 'verifying' : 'testing'
        task.submission = { sha: args.sha, summary: args.summary, tests: args.tests }
        return this.taskResult(task)
      }
      case 'task_mark_deployed': {
        const task = this.claimed(args)
        if (task.status !== 'pending_release') throw new Rejection('invalid_request', 'task_not_ready')
        if (Number(args.revision) !== task.revision) throw new Rejection('conflict', 'revision_mismatch')
        // Only the version the product tested may ship.
        if (args.sha !== task.submission?.sha) throw new Rejection('conflict', 'sha_not_tested')
        task.status = 'review'
        task.deployment = { sha: args.sha, environment: args.environment }
        return this.taskResult(task)
      }
      case 'task_rework': {
        const task = this.claimed(args)
        task.status = 'doing'
        return this.taskResult(task)
      }
      case 'task_release': {
        const task = this.claimed(args)
        task.status = 'ready'
        task.claimant = null
        task.claim_id = null
        return this.taskResult(task)
      }
      case 'task_close':
      case 'task_decline': {
        const task = this.task(args)
        if (args.user_confirmed !== 'true') throw new Rejection('invalid_request', 'user_confirmation_required')
        current(task, args)
        task.status = tool === 'task_close' ? 'closed' : 'rejected'
        task.claimant = null
        task.claim_id = null
        return this.taskResult(task)
      }
      case 'collaboration_get':
        return { ...this.collaboration(args, false), claim_id: undefined }
      case 'collaboration_claim': {
        const item = this.collaboration(args, false)
        if (item.status !== 'pending') throw new Rejection('invalid_request', 'collaboration_not_pending')
        item.status = 'investigating'
        item.claimant = CLIENT
        item.claim_id = 'clm_' + randomUUID().slice(0, 8)
        item.lease_until = Date.now() + 600_000
        return this.collabResult(item, item.claim_id)
      }
      case 'collaboration_report': {
        const item = this.collaboration(args, true)
        item.lease_until = Date.now() + 600_000
        return this.collabResult(item)
      }
      case 'collaboration_submit_result': {
        const item = this.collaboration(args, true)
        current(item, args)
        if (!['confirmed', 'inconclusive', 'cannot_access'].includes(args.outcome)) throw new Rejection('invalid_request', 'outcome_invalid')
        if (args.outcome === 'confirmed' && !args.evidence?.trim()) throw new Rejection('invalid_request', 'evidence_required')
        item.status = 'completed'
        item.result = { outcome: args.outcome, summary: args.summary }
        return this.collabResult(item)
      }
      case 'collaboration_release': {
        const item = this.collaboration(args, true)
        item.status = 'pending'
        item.claimant = null
        item.claim_id = null
        return this.collabResult(item)
      }
      default:
        throw new Rejection('invalid_request', 'unknown_tool')
    }
  }
}

// A tool error the way the real platform reports it: a stable code, and
// whether resending the same request can help.
class Rejection extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
  }
}

// Fields and required fields of each tool, copied from the real platform. The
// real one ignores unknown fields on most tools; the fake refuses them so a
// misspelt field fails here instead of silently going missing.
const RESOLUTION = { fields: ['task_id', 'request_id', 'version', 'body', 'user_confirmed', 'user_instruction'], required: ['task_id', 'request_id', 'version', 'body', 'user_confirmed', 'user_instruction'] }
const TOOLS: Record<string, { fields: string[]; required: string[] }> = {
  project_get_context: { fields: [], required: [] },
  work_list: { fields: ['project_version_id'], required: [] },
  task_get_context: { fields: ['task_id'], required: ['task_id'] },
  task_claim: { fields: ['task_id', 'request_id', 'branch', 'project_version_id'], required: ['task_id', 'request_id'] },
  task_report_work: { fields: ['task_id', 'request_id', 'claim_id', 'body', 'report_kind'], required: ['task_id', 'request_id', 'claim_id', 'body'] },
  task_request_alignment: { fields: ['task_id', 'request_id', 'claim_id', 'version', 'revision', 'body', 'questions'], required: ['task_id', 'request_id', 'claim_id', 'version', 'revision', 'body'] },
  task_resume_development: { fields: ['task_id', 'request_id', 'claim_id', 'version', 'revision', 'body'], required: ['task_id', 'request_id', 'claim_id', 'version', 'revision', 'body'] },
  task_submit_result: { fields: ['task_id', 'request_id', 'claim_id', 'revision', 'summary', 'sha', 'environment', 'tests', 'limitations', 'references'], required: ['task_id', 'request_id', 'claim_id', 'revision', 'summary', 'sha', 'tests'] },
  task_mark_deployed: { fields: ['task_id', 'request_id', 'claim_id', 'revision', 'sha', 'environment', 'body'], required: ['task_id', 'request_id', 'claim_id', 'revision', 'sha', 'environment', 'body'] },
  task_rework: { fields: ['task_id', 'request_id', 'claim_id', 'body'], required: ['task_id', 'request_id', 'claim_id', 'body'] },
  task_release: { fields: ['task_id', 'request_id', 'claim_id', 'body'], required: ['task_id', 'request_id', 'claim_id', 'body'] },
  task_close: RESOLUTION,
  task_decline: RESOLUTION,
  collaboration_get: { fields: ['collaboration_id'], required: ['collaboration_id'] },
  collaboration_claim: { fields: ['collaboration_id', 'request_id'], required: ['collaboration_id', 'request_id'] },
  collaboration_report: { fields: ['collaboration_id', 'request_id', 'claim_id', 'body', 'report_kind'], required: ['collaboration_id', 'request_id', 'claim_id', 'body'] },
  collaboration_release: { fields: ['collaboration_id', 'request_id', 'claim_id', 'body'], required: ['collaboration_id', 'request_id', 'claim_id', 'body'] },
  collaboration_submit_result: {
    fields: ['collaboration_id', 'request_id', 'claim_id', 'version', 'outcome', 'summary', 'evidence', 'environment', 'observed_at', 'deployment_version', 'limitations'],
    required: ['collaboration_id', 'request_id', 'claim_id', 'version', 'outcome', 'summary', 'environment', 'observed_at', 'deployment_version', 'limitations'],
  },
}

function checkArgs(tool: string, args: any) {
  const spec = TOOLS[tool]
  if (!spec) throw new Rejection('invalid_request', 'unknown_tool')
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value !== 'string') throw new Rejection('invalid_request', `参数 ${key} 必须是字符串`)
    if (!spec.fields.includes(key)) throw new Rejection('invalid_request', `不支持参数 ${key}`)
  }
  for (const key of spec.required) {
    if (!String(args?.[key] ?? '').trim()) throw new Rejection('invalid_request', `缺少 ${key}`)
  }
}

function current(item: { version: number; revision?: number }, args: any) {
  if (Number(args.version) !== item.version) throw new Rejection('conflict', 'version_mismatch')
  if (args.revision !== undefined && Number(args.revision) !== item.revision) throw new Rejection('conflict', 'revision_mismatch')
}

// The requirement-review question format: at most 8, each with a unique id,
// a label and a known control type.
function questions(raw: string): unknown[] {
  let list: any
  try {
    list = JSON.parse(raw)
  } catch {
    throw new Rejection('invalid_request', 'questions_not_json')
  }
  const types = ['text', 'textarea', 'select', 'radio', 'multiselect']
  const ids = new Set<string>()
  const keys = ['id', 'label', 'type', 'options', 'recommended', 'reason', 'required']
  const valid = Array.isArray(list) && list.length <= 8 && list.every((q) =>
    q && Object.keys(q).every((k) => keys.includes(k)) && typeof q.id === 'string' && q.id && !ids.has(q.id) && ids.add(q.id) &&
    typeof q.label === 'string' && q.label.trim() && types.includes(q.type) && Array.isArray(q.options) && Array.isArray(q.recommended) &&
    typeof q.reason === 'string' && typeof q.required === 'boolean')
  if (!valid) throw new Rejection('invalid_request', 'questions_invalid')
  return list
}
