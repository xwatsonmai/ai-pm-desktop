// Runs one ZCode turn over `app-server --stdio` and exits. Started detached by
// the ZCode executor (`node zcode-runner.js <request.json>`) so the turn
// survives a client restart. Its stdout is the run's event log: one JSON line
// per event, starting with the session id and ending with the result. The
// final reply goes to `outPath`. Node built-ins only: this file runs on its own.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunMessage } from './run-messages.js'
import { createInterface } from 'node:readline'

interface Request {
  command: string[]
  env: Record<string, string>
  cwd: string
  prompt: string
  sessionId?: string
  mode: string
  model?: { providerId: string; modelId: string; options?: { reasoningLevel?: string } }
  effort?: string
  mcpServers: unknown[]
  outPath: string
}

const request = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Request
const controller = new AbortController()
let account: ReturnType<typeof import('./zcode-account.js').createZcodeAccountBridge>
const line = (value: object) => process.stdout.write(JSON.stringify(value) + '\n')

const child = spawn(request.command[0], [...request.command.slice(1), 'app-server', '--stdio'], {
  cwd: request.cwd,
  env: { ...process.env, ...request.env },
  stdio: ['pipe', 'pipe', 'inherit'],
})
const pending = new Map<number, (message: any) => void>()
const listeners = new Set<(params: any) => void>()
let nextId = 0
let finished = false
let stopping = false
let stopMessages = () => {}

function finish(status: 'completed' | 'failed' | 'interrupted', error?: string) {
  if (finished) return
  finished = true
  stopMessages()
  controller.abort()
  line({ type: 'zcode.result', status, ...(error ? { error } : {}) })
  child.kill('SIGTERM')
  process.exit(status === 'completed' ? 0 : 1)
}

child.on('error', (error) => finish('failed', 'ZCode 启动失败：' + error.message))
// app-server dying mid-turn leaves no result: the turn is interrupted, as when an agent process crashes.
child.on('exit', (code) => finish('interrupted', stopping ? 'stopped' : `ZCode app-server 退出（${code}）`))
child.stdin.on('error', () => {})

createInterface({ input: child.stdout }).on('line', (text) => {
  let message: any
  try {
    message = JSON.parse(text)
  } catch {
    return // not a protocol line
  }
  if (message.id != null && message.method) {
    if (message.method === 'interaction/requestProviderRuntimeHeaders' && account) {
      void account.headers(message.params ?? {}).then((result) => {
        if (!finished) child.stdin.write(JSON.stringify({ id: message.id, result }) + '\n')
      })
      return
    }
    // Requests from ZCode. Agents run unattended: answer the runtime
    // preferences, refuse anything that would need a person.
    const reply = message.method === 'session/requestRuntimePreferences'
      ? { result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } }
      : { error: { code: -32601, message: 'ai_pm_unattended' } }
    child.stdin.write(JSON.stringify({ id: message.id, ...reply }) + '\n')
  } else if (message.id != null) {
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  } else if (message.method === 'session/event') {
    for (const listener of listeners) listener(message.params ?? {})
  }
})

function call(method: string, params: object, timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(method + ' 超时'))
    }, timeoutMs)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(`${method}：${message.error.message ?? JSON.stringify(message.error)}`))
      else resolve(message.result)
    })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}

// The assistant's text in one turn.
function replyOf(state: any, turnId: string | undefined): string {
  const texts: string[] = []
  for (const message of state?.messages ?? []) {
    const info = message.info ?? message
    if (info.role !== 'assistant' || (turnId && info.turnId && info.turnId !== turnId)) continue
    for (const part of message.parts ?? []) if (part.type === 'text' && part.text) texts.push(part.text)
  }
  return texts.join('\n')
}

// Bookkeeping events, and tool input streamed piece by piece (its tool_call carries it whole).
const QUIET = new Set(['session.updated', 'session.titleUpdated', 'streamRecovery.updated', 'tool_input_start', 'tool_input_delta', 'tool_input_end'])

let sessionId = request.sessionId
// A stop signals the whole process group, so app-server may exit first.
process.on('SIGTERM', () => {
  stopping = true
  const stop = sessionId ? call('session/stop', { sessionId }, 2_000).catch(() => {}) : Promise.resolve()
  void stop.finally(() => finish('interrupted', 'stopped'))
})

// Tools that wait for a person. In plan mode the model would otherwise hand its
// result to ExitPlanMode for approval instead of replying with it.
const UNATTENDED_DENY = ['ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion']

async function main() {
  // The detached runner uses plain Node (no TS loader). Tests run its source;
  // packaged clients use the compiled sibling. Resolve the sibling explicitly.
  const compiledAccount = new URL('./zcode-account.js', import.meta.url)
  const moduleUrl = existsSync(compiledAccount) ? compiledAccount : new URL('./zcode-account.ts', import.meta.url)
  const { createZcodeAccountBridge } = await import(moduleUrl.href) as typeof import('./zcode-account.js')
  const compiledSelection = new URL('./zcode-selection.js', import.meta.url)
  const selectionUrl = existsSync(compiledSelection) ? compiledSelection : new URL('./zcode-selection.ts', import.meta.url)
  const { resolveZcodeSelection } = await import(selectionUrl.href) as typeof import('./zcode-selection.js')
  const compiledMessages = new URL('./run-messages.js', import.meta.url)
  const { writeOnce } = await import((existsSync(compiledMessages) ? compiledMessages : new URL('./run-messages.ts', import.meta.url)).href) as typeof import('./run-messages.js')
  account = createZcodeAccountBridge({ env: { ...process.env, ...request.env }, signal: controller.signal })
  if (account) await call('provider/updateAccountConfig', await account.snapshot())
  const workspace = { workspacePath: request.cwd, workspaceKey: request.cwd }
  const tools = { mcpServers: request.mcpServers, toolDenylist: UNATTENDED_DENY }
  // A partial explicit model is rejected before the catalog is returned.
  // Obtain metadata first, then apply the complete selection before any send.
  const create = () => call('session/create', { workspace, ...tools, mode: request.mode, titleGenerationEnabled: false }, 120_000)
  const state = request.sessionId
    ? await call('session/resume', { sessionId: request.sessionId, workspace, ...tools }, 120_000)
    : await create()
  sessionId = state?.session?.sessionId
  if (!sessionId) throw new Error('ZCode 没有返回会话 ID')
  let catalog = state
  // Resumed sessions may report only their current model. Resolve another
  // requested model against a fresh catalog, without sending any prompt.
  if (request.model && !(state.settings?.model?.available ?? []).some((m: any) => m.ref.providerId === request.model!.providerId && m.ref.modelId === request.model!.modelId)) {
    catalog = await create()
    await call('session/close', { sessionId: catalog.session.sessionId })
  }
  const model = resolveZcodeSelection(catalog, request.model, request.effort)
  if (model) await call('session/setModel', { sessionId, model })
  line({ type: 'zcode.session', sessionId, model: model ?? state.session.model ?? null })
  await call('session/setMode', { sessionId, mode: request.mode })

  // Events replayed from earlier turns arrive before the send; log only this turn's.
  const inputId = randomUUID()
  let sent = false
  let replayedUpTo = -1
  let turnId: string | undefined
  const directory = join(dirname(request.outPath), 'messages')
  const ready = join(directory, 'ready.json')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const inputIds = new Set<string>([inputId])
  const undrained = new Set<string>()
  let closing = false
  let messageBusy = false
  let lastTerminal: any = null
  const messageError = (id: string, error: string) => {
    line({ type: 'zcode.user_error', id, error })
    writeOnce(join(directory, id + '.receipt.json'), { ok: false, error })
  }
  const requests = () => readdirSync(directory).filter(f => /^[a-zA-Z0-9-]{16,80}\.request\.json$/.test(f))
    .map(f => JSON.parse(readFileSync(join(directory, f), 'utf8')) as RunMessage)
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const drainMessages = async () => {
    if (messageBusy || !turnId) return
    messageBusy = true
    try {
      for (const message of requests()) {
        const receipt = join(directory, message.id + '.receipt.json')
        if (existsSync(receipt)) continue
        line({ type: 'zcode.user', id: message.id, text: message.text })
        if (closing) { messageError(message.id, '这一轮已经结束，补充指令未发送'); continue }
        inputIds.add(message.id)
        undrained.add(message.id)
        try {
          const result = await call('v4/command', {
            commandId: message.id, clientId: 'ai-pm-desktop', connectionId: 'ai-pm-' + process.pid,
            sessionId, type: 'sendText', issuedAt: Date.parse(message.at), clientMode: 'desktop-continuous',
            payload: { inputId: message.id, text: message.text, content: message.text, requestedDelivery: 'guide', attachments: [] },
          })
          if (result?.status !== 'accepted' || result?.result?.type !== 'inputAccepted') throw Error('ZCode 未接受补充指令')
          writeOnce(receipt, { ok: true })
        } catch (error) {
          undrained.delete(message.id)
          messageError(message.id, error instanceof Error ? error.message : String(error))
        }
      }
    } finally { messageBusy = false }
  }
  let poll: ReturnType<typeof setInterval> | undefined
  stopMessages = () => {
    if (poll) clearInterval(poll)
    if (existsSync(ready)) unlinkSync(ready)
    writeOnce(join(directory, 'closed.json'), { at: new Date().toISOString() })
  }
  const done = new Promise<any>((resolve) => {
    listeners.add((params) => {
      if (params.sessionId && params.sessionId !== sessionId) return
      if (!sent) {
        replayedUpTo = Math.max(replayedUpTo, Number(params.seq ?? -1))
        return
      }
      if (Number(params.seq ?? Infinity) <= replayedUpTo) return
      if (!QUIET.has(params.type) && !QUIET.has(params.payload?.kind)) line({ type: 'zcode.event', event: params })
      if (params.type === 'turn.steerDrained') {
        for (const item of params.payload?.drainedInputs ?? []) undrained.delete(item.intent?.sourceCommandId ?? String(item.pendingInputId ?? '').replace(/^queue_/, ''))
      }
      if (params.type === 'turn.started' && inputIds.has(params.payload?.inputId)) {
        turnId = params.turnId
        lastTerminal = null
      }
      const ours = inputIds.has(params.payload?.inputId) || (turnId && params.turnId === turnId)
      if (ours && (params.type === 'turn.completed' || params.type === 'turn.failed')) {
        lastTerminal = params
        closing = true
        if (existsSync(ready)) unlinkSync(ready)
        // Let an already-sent RPC settle; never release the run while a user
        // message can still start/continue work in this same owned session.
        const settle = async () => {
          await drainMessages()
          if (messageBusy || lastTerminal !== params) { if (lastTerminal === params) setTimeout(() => void settle(), 100); return }
          for (const id of undrained) line({ type: 'zcode.user_error', id, error: '轮次结束前未确认注入，请检查回复后再继续' })
          resolve(params)
        }
        setTimeout(() => void settle(), 250)
      }
    })
  })
  await call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: false })
  sent = true
  const response = await call('session/send', {
    sessionId, inputId, content: request.prompt, ...(model ? { modelSelection: model } : {}),
  })
  if (response?.accepted === false) throw new Error('ZCode 没有接受这条消息')
  if (!closing) {
    writeFileSync(ready, JSON.stringify({ version: 1, sessionId, pid: process.pid }), { mode: 0o600 })
    poll = setInterval(() => void drainMessages().catch(error => line({ type: 'zcode.message_channel_error', error: String(error) })), 150)
  }
  const terminal = await done
  // The turn's own reply. Messages read back from the session carry no turn id,
  // so they are only a fallback: they hold every earlier turn's replies too.
  const reply = typeof terminal.payload?.response === 'string' && terminal.payload.response
    ? terminal.payload.response
    : replyOf(await call('session/read', { sessionId }), terminal.turnId ?? turnId)
  writeFileSync(request.outPath, reply)
  if (terminal.type === 'turn.completed' && (terminal.payload?.resultType ?? 'success') === 'success') finish('completed')
  else finish('failed', terminal.payload?.error?.message ?? terminal.payload?.resultType ?? 'turn failed')
}

main().catch((error) => finish('failed', error instanceof Error ? error.message : String(error)))
