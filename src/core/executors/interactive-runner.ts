// One detached process owns the CLI pipes and durable local message mailbox.
// The desktop can restart without closing the native session or losing input.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { RunSpec } from './types.js'
import type { RunMessage } from './run-messages.js'

const here = dirname(process.argv[1])
const load = (name: string) => import(existsSync(join(here, name + '.js')) ? './' + name + '.js' : './' + name + '.ts')
const { commandLine } = await load('process') as typeof import('./process.js')
const { writeOnce } = await load('run-messages') as typeof import('./run-messages.js')
const { isCodexTrustConfig } = await load('codex-config') as typeof import('./codex-config.js')
const request = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  kind: 'codex' | 'claude'; binary: string; args: string[]; spec: RunSpec; outPath: string; isolate: boolean
}
const { spec } = request
const directory = join(spec.dir, 'messages'), ready = join(directory, 'ready.json')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const emit = (event: object) => process.stdout.write(JSON.stringify(event) + '\n')
const children: ChildProcessWithoutNullStreams[] = []
let finished = false, closing = false, busy = false
let timer: ReturnType<typeof setInterval> | undefined
let deliver: (message: RunMessage) => Promise<void>
const seen = new Set<string>()
const removeReady = () => { if (existsSync(ready)) unlinkSync(ready) }
function finish(error?: string, interrupted = false) {
  if (finished) return
  finished = true; closing = true
  clearInterval(timer); removeReady()
  writeOnce(join(directory, 'closed.json'), { at: new Date().toISOString() })
  if (error && interrupted) process.stderr.write(error + '\n')
  if (error && !interrupted) emit(request.kind === 'codex'
    ? { type: 'turn.failed', error: { message: error } }
    : { type: 'result', subtype: 'error_during_execution', is_error: true, result: error })
  for (const child of children) child.kill('SIGTERM')
  process.exit(error ? 1 : 0)
}
function launch(args: string[], env = process.env) {
  const cmd = commandLine(request.binary, args)
  const child = spawn(cmd.file, cmd.args, { cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: cmd.verbatim })
  children.push(child)
  child.stderr.pipe(process.stderr)
  child.stdin.on('error', () => {})
  child.on('error', error => finish(error.message))
  child.on('exit', code => { if (!finished) finish(`执行器退出（${code}），本轮未正常结束`, true) })
  return child
}
async function drain() {
  if (busy || finished) return
  busy = true
  try {
    const messages = readdirSync(directory).filter(f => f.endsWith('.request.json'))
      .map(f => JSON.parse(readFileSync(join(directory, f), 'utf8')) as RunMessage)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    for (const message of messages) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
      emit({ type: 'run.user', id: message.id, text: message.text })
      try {
        if (closing) throw Error('当前轮次已结束，补充指令未发送')
        await deliver(message)
        writeOnce(join(directory, message.id + '.receipt.json'), { ok: true })
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        emit({ type: 'run.user_error', id: message.id, error: text })
        writeOnce(join(directory, message.id + '.receipt.json'), { ok: false, error: text })
      }
    }
  } finally { busy = false }
}
function available(sessionId: string) {
  if (closing || finished) return
  writeFileSync(ready, JSON.stringify({ version: 1, pid: process.pid, sessionId }), { mode: 0o600 })
  timer = setInterval(() => void drain().catch(error => finish(String(error))), 100)
}
function rpc(child: ChildProcessWithoutNullStreams, notification: (method: string, params: any) => void,
  serverRequest?: (method: string, params: any) => Promise<object>) {
  let nextId = 0
  const pending = new Map<number, (message: any) => void>()
  const write = (message: object) => child.stdin.write(JSON.stringify(message) + '\n')
  createInterface({ input: child.stdout }).on('line', line => {
    let message: any
    try { message = JSON.parse(line) } catch { return }
    if (message.id != null && message.method) {
      void (serverRequest ? serverRequest(message.method, message.params) : Promise.reject(Error('ai_pm_unattended')))
        .then(result => write({ id: message.id, result }), error => write({ id: message.id, error: { code: -32601, message: String(error) } }))
    } else if (message.id != null) { pending.get(message.id)?.(message); pending.delete(message.id) }
    else if (message.method) notification(message.method, message.params ?? {})
  })
  return {
    notify: (method: string, params = {}) => write({ method, params }),
    call: (method: string, params: object, timeout = 30_000): Promise<any> => new Promise((resolve, reject) => {
      const id = ++nextId
      const timeoutId = setTimeout(() => { pending.delete(id); reject(Error(method + ' 超时')) }, timeout)
      pending.set(id, message => { clearTimeout(timeoutId); message.error ? reject(Error(method + ': ' + message.error.message)) : resolve(message.result) })
      write({ id, method, params })
    }),
  }
}
const initialize = async (peer: ReturnType<typeof rpc>) => {
  await peer.call('initialize', { clientInfo: { name: 'ai-pm-desktop', version: '0.1.7' }, capabilities: { experimentalApi: true } }, 90_000)
  peer.notify('initialized')
}
const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }]

// app-server has no --ignore-user-config switch. Use a private configuration
// home and memory-only native auth, while linking only session history to the
// original home. Never rename/edit user config or copy tokens into run files.
function isolatedCodexHome() {
  const original = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))
  const isolated = join(dirname(dirname(spec.dir)), 'codex-runtime')
  mkdirSync(isolated, { recursive: true, mode: 0o700 })
  const configFile = join(isolated, 'config.toml')
  if (existsSync(configFile) && !isCodexTrustConfig(readFileSync(configFile, 'utf8'))) {
    throw Error('Codex 隔离目录含有项目可信记录以外的配置，请先检查 codex-runtime/config.toml')
  }
  for (const name of ['sessions', 'archived_sessions']) {
    const source = join(original, name), target = join(isolated, name)
    mkdirSync(source, { recursive: true })
    if (!existsSync(target)) {
      try { symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    if (realpathSync(target) !== realpathSync(source)) throw Error('Codex 会话目录与当前登录不一致')
  }
  // This is model metadata only, not auth/config. A warm catalog avoids an
  // unauthenticated network lookup before memory-only login is initialized.
  if (existsSync(join(original, 'models_cache.json'))) {
    const temp = join(isolated, 'models-' + randomUUID() + '.tmp')
    try { copyFileSync(join(original, 'models_cache.json'), temp); renameSync(temp, join(isolated, 'models_cache.json')) }
    finally { if (existsSync(temp)) unlinkSync(temp) }
  }
  return { isolated, original }
}

async function codex() {
  let auth: ReturnType<typeof rpc> | undefined
  let authPayload: (() => Promise<any>) | undefined
  let env = process.env
  const args = ['app-server', ...request.args]
  if (request.isolate) {
    auth = rpc(launch(['app-server']), () => {})
    await initialize(auth)
    let accountId: string | undefined
    authPayload = async () => {
      const status = await auth!.call('getAuthStatus', { includeToken: true, refreshToken: true })
      if (!status.authToken) throw Error('Codex 尚未登录，请先在 Codex 登录')
      if (status.authMethod === 'apikey') return { type: 'apiKey', apiKey: status.authToken }
      if (status.authMethod !== 'chatgpt' && status.authMethod !== 'chatgptAuthTokens') throw Error('当前 Codex 登录方式暂不支持隔离会话')
      const claims = JSON.parse(Buffer.from(status.authToken.split('.')[1], 'base64url').toString())
      const account = claims['https://api.openai.com/auth'] ?? {}
      if (!account.chatgpt_account_id) throw Error('Codex 登录缺少账号标识')
      if (accountId && accountId !== account.chatgpt_account_id) throw Error('Codex 账号已更换，不能替换当前运行的会话授权')
      accountId = account.chatgpt_account_id
      return { type: 'chatgptAuthTokens', accessToken: status.authToken, chatgptAccountId: account.chatgpt_account_id, chatgptPlanType: account.chatgpt_plan_type ?? null }
    }
    const { isolated, original } = isolatedCodexHome()
    env = { ...process.env, CODEX_HOME: isolated }
    args.push('-c', 'cli_auth_credentials_store="ephemeral"', '-c', 'sqlite_home=' + JSON.stringify(original))
  }
  let threadId = '', turnId = '', finalText = ''
  let terminal: any
  const peer = rpc(launch(args, env), (method, params) => {
    if (params.threadId && params.threadId !== threadId) return
    if (method === 'turn/started') { turnId = params.turn.id; emit({ type: 'turn.started' }) }
    if (method === 'item/started' || method === 'item/completed') {
      const native = params.item ?? {}
      const type = ({ agentMessage: 'agent_message', commandExecution: 'command_execution', fileChange: 'file_change' } as Record<string, string>)[native.type] ?? native.type
      const item = { ...native, type, text: native.type === 'reasoning' ? [...(native.summary ?? []), ...(native.content ?? [])].join('\n') : native.text,
        aggregated_output: native.aggregatedOutput, exit_code: native.exitCode }
      if (method === 'item/completed' && native.type === 'agentMessage' && native.phase !== 'commentary') finalText = native.text ?? ''
      emit({ type: method === 'item/started' ? 'item.started' : 'item.completed', item })
    }
    if (method === 'turn/completed' && params.turn.id === turnId) {
      terminal = params.turn; closing = true; removeReady()
      void settle()
    }
  }, async method => {
    if (method !== 'account/chatgptAuthTokens/refresh' || !authPayload) throw Error('ai_pm_unattended')
    const { accessToken, chatgptAccountId, chatgptPlanType } = await authPayload()
    return { accessToken, chatgptAccountId, chatgptPlanType }
  })
  async function settle() {
    if (busy) { setTimeout(() => void settle(), 100); return }
    await drain()
    if (terminal.status !== 'completed') { finish(terminal.error?.message ?? 'Codex 本轮未完成', terminal.status === 'interrupted'); return }
    writeFileSync(request.outPath, finalText)
    emit({ type: 'turn.completed' })
    finish()
  }
  await initialize(peer)
  if (authPayload) await peer.call('account/login/start', await authPayload())
  const thread = await peer.call(spec.sessionId ? 'thread/resume' : 'thread/start', {
    ...(spec.sessionId ? { threadId: spec.sessionId } : {}), cwd: spec.cwd, model: spec.model,
    approvalPolicy: 'never', sandbox: 'danger-full-access',
  })
  threadId = thread.thread.id
  emit({ type: 'thread.started', thread_id: threadId })
  deliver = async message => {
    const result = await peer.call('turn/steer', { threadId, expectedTurnId: turnId, input: textInput(message.text), clientUserMessageId: message.id })
    if (result.turnId !== turnId) throw Error('执行器未确认原轮次插话')
  }
  const turn = await peer.call('turn/start', { threadId, input: textInput(spec.prompt), outputSchema: spec.schema, effort: spec.effort })
  turnId ||= turn.turn.id
  available(threadId)
}

async function claude() {
  const child = launch(request.args)
  const acknowledgements = new Set<string>()
  let sessionId = spec.sessionId ?? request.args[request.args.indexOf('--session-id') + 1]
  let terminal: any, outstanding = 0
  const send = (id: string, text: string) => child.stdin.write(JSON.stringify({
    type: 'user', uuid: id, session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: text },
  }) + '\n')
  const settle = async () => {
    if (busy || outstanding) { setTimeout(() => void settle(), 100); return }
    await drain()
    emit(terminal)
    finish()
  }
  createInterface({ input: child.stdout }).on('line', line => {
    let event: any
    try { event = JSON.parse(line) } catch { return }
    if (event.type === 'system' && event.subtype === 'init') { sessionId = event.session_id; available(sessionId) }
    if (event.type === 'user' && acknowledgements.has(event.uuid)) {
      acknowledgements.delete(event.uuid)
      return // our durable run.user event already displays this message once
    }
    if (event.type === 'result' && !event.parent_tool_use_id) {
      outstanding = Math.max(0, outstanding - 1)
      terminal = event
      // Stream input is processed in order. A result may precede processing
      // an already-written user message; keep the process and slot until done.
      if (!outstanding) { closing = true; removeReady(); void settle() }
      return
    }
    emit(event)
  })
  deliver = message => new Promise((resolve, reject) => {
    acknowledgements.add(message.id)
    outstanding++
    // Claude acknowledges a queued input when processing it, which can be
    // after a long tool call. Confirm pipe delivery without blocking the form
    // for that entire tool call. Keep the session alive for its later result.
    child.stdin.write(JSON.stringify({ type: 'user', uuid: message.id, session_id: sessionId,
      parent_tool_use_id: null, message: { role: 'user', content: message.text } }) + '\n', error => {
      if (error) { outstanding--; acknowledgements.delete(message.id); reject(error) } else resolve()
    })
  })
  outstanding++
  send(randomUUID(), spec.prompt)
}

void (request.kind === 'codex' ? codex() : claude()).catch(error => finish(error instanceof Error ? error.message : String(error)))
