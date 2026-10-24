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
  claimant: string | null
  claim_id: string | null
  alignment: { status: string; questions?: unknown; reply?: string } | null
  submission: Record<string, unknown> | null
  deployment: Record<string, unknown> | null
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
  | { tool: string; kind: 'reject'; code: string }

export const TOKEN = 'test-token'
const CLIENT = 'desktop-client'

export class FakePlatform {
  readonly project = { id: 'prj_test', repository: '' }
  readonly resourceUri = 'ai-pm://projects/prj_test/work'
  tasks = new Map<string, FakeTask>()
  collaborations = new Map<string, FakeCollaboration>()
  calls: { tool: string; args: any; outcome: string }[] = []
  faults: Fault[] = []
  notifyEnabled = true
  brokenContext = new Set<string>() // task_get_context fails with a transient error for these ids
  private receipts = new Map<string, { tool: string; args: string; result: any }>()
  private listeners = new Set<ServerResponse>()
  private server: Server | null = null
  url = ''

  constructor(repository: string) {
    this.project.repository = repository
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        res.writeHead(500).end(String(error))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp`
    return this.url
  }

  async stop() {
    for (const res of this.listeners) res.end()
    this.listeners.clear()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
    this.server?.closeAllConnections()
  }

  // ---- test controls ----

  addTask(id: string, title = '测试需求 ' + id): FakeTask {
    const task: FakeTask = {
      id, project_id: this.project.id, title, status: 'ready', revision: 1, version: 1,
      brief: '为 ' + title + ' 实现功能', acceptance_criteria: '功能可用，测试通过',
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

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === 'GET') return void res.writeHead(405).end()
    if (req.method === 'DELETE') return void res.writeHead(200).end()
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return void res.writeHead(401).end()
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const message = JSON.parse(Buffer.concat(chunks).toString())
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
    if (fault?.kind === 'reject') {
      this.calls.push({ tool, args, outcome: 'rejected' })
      return reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: fault.code, message: '平台拒绝：' + fault.code }) }] })
    }
    let result: any
    try {
      result = this.apply(tool, args)
    } catch (error) {
      const code = (error as Error).message
      this.calls.push({ tool, args, outcome: 'rejected' })
      return reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message: '平台拒绝：' + code }) }] })
    }
    this.calls.push({ tool, args, outcome: fault?.kind === 'drop_response' ? 'dropped' : 'ok' })
    if (fault?.kind === 'drop_response') return void res.writeHead(502).end('lost')
    reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
  }

  // Idempotent on request_id: the same request returns its first result.
  private apply(tool: string, args: any): any {
    const requestId: string | undefined = args.request_id
    if (requestId) {
      const previous = this.receipts.get(requestId)
      const fingerprint = JSON.stringify(args)
      if (previous) {
        if (previous.tool !== tool || previous.args !== fingerprint) throw new Error('idempotency_conflict')
        return previous.result
      }
      const result = this.execute(tool, args)
      this.receipts.set(requestId, { tool, args: fingerprint, result })
      this.changed()
      return result
    }
    return this.execute(tool, args)
  }

  private task(args: any): FakeTask {
    const task = this.tasks.get(args.task_id)
    if (!task) throw new Error('task_not_found')
    return task
  }

  private claimed(args: any): FakeTask {
    const task = this.task(args)
    if (task.claimant !== CLIENT || task.claim_id !== args.claim_id) throw new Error('claim_invalid')
    return task
  }

  private execute(tool: string, args: any): any {
    switch (tool) {
      case 'project_get_context':
        return { project: { ...this.project } }
      case 'work_list': {
        const mine = (s: { claimant: string | null }) => s.claimant === CLIENT
        return {
          tasks: [...this.tasks.values()].filter((t) => t.status === 'ready' || mine(t)).map((t) => ({ ...t, claim_id: undefined })),
          collaborations: [...this.collaborations.values()].filter((c) => c.status === 'pending' || mine(c)).map((c) => ({ ...c, claim_id: undefined })),
        }
      }
      case 'task_get_context': {
        if (this.brokenContext.has(args.task_id)) throw new Error('internal_error')
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
        if (task.status !== 'ready' || (task.alignment && task.alignment.status !== 'completed')) throw new Error('task_not_ready')
        task.status = 'doing'
        task.claimant = CLIENT
        task.claim_id = 'clm_' + randomUUID().slice(0, 8)
        task.version += 1
        return { claim_id: task.claim_id, task: { id: task.id, claimant: CLIENT } }
      }
      case 'task_report_work':
        this.claimed(args)
        return { ok: true }
      case 'task_request_alignment': {
        const task = this.claimed(args)
        task.status = 'aligning'
        task.alignment = { status: 'pending', questions: args.questions }
        task.version += 1
        return { ok: true }
      }
      case 'task_resume_development': {
        const task = this.claimed(args)
        if (task.alignment?.status !== 'replied') throw new Error('alignment_not_replied')
        task.status = 'doing'
        task.alignment = { ...task.alignment, status: 'completed' }
        task.claim_id = 'clm_' + randomUUID().slice(0, 8)
        task.version += 1
        return { claim_id: task.claim_id }
      }
      case 'task_submit_result': {
        const task = this.claimed(args)
        if (task.status !== 'doing') throw new Error('task_not_doing')
        if (args.revision !== task.revision) throw new Error('revision_mismatch')
        task.status = 'testing'
        task.submission = { sha: args.sha, summary: args.summary, tests: args.tests }
        task.version += 1
        return { ok: true, status: 'testing' }
      }
      case 'task_mark_deployed': {
        const task = this.claimed(args)
        if (task.status !== 'pending_release') throw new Error('task_not_ready')
        task.status = 'review'
        task.deployment = { sha: args.sha, environment: args.environment }
        task.version += 1
        return { ok: true, status: 'review' }
      }
      case 'task_rework': {
        const task = this.claimed(args)
        task.status = 'doing'
        task.version += 1
        return { ok: true }
      }
      case 'task_release': {
        const task = this.claimed(args)
        task.status = 'ready'
        task.claimant = null
        task.claim_id = null
        task.version += 1
        return { ok: true }
      }
      case 'task_close':
      case 'task_decline': {
        const task = this.task(args)
        if (args.user_confirmed !== true) throw new Error('user_confirmation_required')
        task.status = tool === 'task_close' ? 'closed' : 'rejected'
        task.version += 1
        return { ok: true }
      }
      case 'collaboration_get': {
        const item = this.collaborations.get(args.collaboration_id)
        if (!item) throw new Error('collaboration_not_found')
        return { ...item, claim_id: undefined }
      }
      case 'collaboration_claim': {
        const item = this.collaborations.get(args.collaboration_id)!
        if (item.status !== 'pending') throw new Error('collaboration_not_pending')
        item.status = 'investigating'
        item.claimant = CLIENT
        item.claim_id = 'clm_' + randomUUID().slice(0, 8)
        item.lease_until = Date.now() + 600_000
        return { claim_id: item.claim_id }
      }
      case 'collaboration_report': {
        const item = this.collaborations.get(args.collaboration_id)!
        if (item.claim_id !== args.claim_id) throw new Error('claim_invalid')
        item.lease_until = Date.now() + 600_000
        return { ok: true }
      }
      case 'collaboration_submit_result': {
        const item = this.collaborations.get(args.collaboration_id)!
        if (item.claim_id !== args.claim_id) throw new Error('claim_invalid')
        item.status = 'completed'
        item.result = { outcome: args.outcome, summary: args.summary }
        return { ok: true }
      }
      case 'collaboration_release': {
        const item = this.collaborations.get(args.collaboration_id)!
        item.status = 'pending'
        item.claimant = null
        item.claim_id = null
        return { ok: true }
      }
      default:
        throw new Error('unknown_tool')
    }
  }
}
