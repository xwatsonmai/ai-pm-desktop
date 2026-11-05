// Opt-in real ZCode capability probe. Only a new session and a temporary
// workspace are used; no AI PM engine, platform or production tasks are started.
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { findExecutor } from '../src/main/find-executor.js'
import { zcodeCommand } from '../src/core/executors/zcode.js'
import { createZcodeAccountBridge } from '../src/core/executors/zcode-account.js'
import { resolveZcodeSelection } from '../src/core/executors/zcode-selection.js'

const root = mkdtempSync(join(tmpdir(), 'ai-pm-zcode-steer-'))
const workspace = join(root, 'workspace'); mkdirSync(workspace)
const started = Date.now()
const cooperative = process.argv.includes('--cooperative')
const events: any[] = []
const record = (kind: string, value: unknown) => {
  events.push({ ms: Date.now() - started, kind, value })
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(events, null, 2), { mode: 0o600 })
}
const config = findExecutor('zcode')
if (!config) throw Error('ZCode not found')
const { command, env } = zcodeCommand({ ...config, limit: 1 })
console.log(JSON.stringify({ evidence: root, version: execFileSync(command[0], [...command.slice(1), '--version'], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim() }))
const abort = new AbortController()
const account = createZcodeAccountBridge({ env: { ...process.env, ...env }, signal: abort.signal })
const child = spawn(command[0], [...command.slice(1), 'app-server', '--stdio'], { cwd: workspace, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', () => {}) // Consume without retaining possibly sensitive provider errors.
const pending = new Map<number, (message: any) => void>()
let next = 0, sessionId: string | undefined
const notifications: any[] = []
const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n')
createInterface({ input: child.stdout }).on('line', text => {
  let m: any; try { m = JSON.parse(text) } catch { return }
  if (m.id != null && m.method) {
    if (m.method === 'interaction/requestProviderRuntimeHeaders' && account) {
      void account.headers(m.params ?? {}).then(result => send({ id: m.id, result }), () => send({ id: m.id, error: { code: -32000, message: 'account bridge failed' } }))
    } else send({ id: m.id, result: m.method === 'session/requestRuntimePreferences' ? { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } : {} })
  } else if (m.id != null) { pending.get(m.id)?.(m); pending.delete(m.id) }
  else { notifications.push(m); record('notification', m) }
})
function call(method: string, params: object, timeout = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')) }, timeout)
    pending.set(id, m => { clearTimeout(timer); m.error ? reject(Error(JSON.stringify({ method, error: m.error }))) : resolve(m.result) })
    send({ id, method, params })
  })
}
async function until(check: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 200)) }
  throw Error('observation timeout')
}
const deadline = setTimeout(() => { console.error('probe deadline'); child.kill(); abort.abort(); process.exit(1) }, 240_000)
try {
  if (account) await call('provider/updateAccountConfig', await account.snapshot())
  const state = await call('session/create', { workspace: { workspacePath: workspace, workspaceKey: workspace }, mode: 'yolo', mcpServers: [], toolDenylist: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'], titleGenerationEnabled: false }, 120_000)
  sessionId = state.session.sessionId
  let model = resolveZcodeSelection(state)
  if (!model) {
    const offered = state.settings?.model?.available?.[0]
    if (!offered) throw Error('No model available: log into ZCode first')
    model = resolveZcodeSelection(state, offered.ref)
  }
  await call('session/setModel', { sessionId, model })
  record('session', { sessionId, model })
  console.log(JSON.stringify({ sessionId, model }))
  await call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: false })
  writeFileSync(join(workspace, 'wait.cjs'), "const fs=require('fs');fs.writeFileSync('command-started','yes');setTimeout(()=>{fs.writeFileSync('command-finished','yes');console.log('WAIT_FINISHED')},30000)\n")
  const firstInput = randomUUID()
  const receipt = await call('session/send', { sessionId, inputId: firstInput, modelSelection: model, content: 'This is an isolated messaging test. Work only in this directory. Run exactly one synchronous shell command: node wait.cjs . Wait for it to finish naturally, do not background or cancel it. Then reply with ORIGINAL_TOKEN only. Do not inspect other directories, use network, or modify other files.' + (cooperative ? '\nAdditional user instructions may arrive while this command runs. Before your final reply, read the latest user message in the conversation; it overrides this initial final-reply token. Follow the latest user instruction without restarting or cancelling the command.' : '') })
  record('initialReceipt', receipt)
  await until(() => existsSync(join(workspace, 'command-started')), 120_000)
  const guide = '用户最新明确指示，覆盖先前的最终回复要求：不要停止或重跑正在运行的 node wait.cjs。等待它自然结束后，只回复 STEER_TOKEN，不要回复 ORIGINAL_TOKEN。请在当前这一轮落实这条补充要求，不要另起任务。'
  record('guideSentWhileCommandRunning', { finished: existsSync(join(workspace, 'command-finished')) })
  const guideReceipt = await call('v4/command', { commandId: randomUUID(), clientId: 'ai-pm-steering-probe', connectionId: 'ai-pm-probe-' + randomUUID(), sessionId, type: 'sendText', issuedAt: Date.now(), clientMode: 'desktop-continuous', payload: { content: guide, text: guide, inputId: randomUUID(), requestedDelivery: 'guide', attachments: [] } })
  record('guideReceipt', guideReceipt)
  console.log(JSON.stringify({ guideReceipt }))
  await until(() => notifications.some(x => x.method === 'session/event' && ['turn.completed', 'turn.failed'].includes(x.params?.type)), 120_000)
  const result = await call('session/read', { sessionId })
  record('finalSnapshot', result)
  const terminal = notifications.filter(x => x.method === 'session/event' && ['turn.completed', 'turn.failed'].includes(x.params?.type))
  const steeringEvents = notifications.filter(x => x.method === 'session/event' && /steer/i.test(x.params?.type ?? '')).map(x => ({ type: x.params.type, turnId: x.params.turnId }))
  const reply = result.messages?.filter((x: any) => (x.info ?? x).role === 'assistant').flatMap((x: any) => x.parts ?? []).filter((x: any) => x.type === 'text').map((x: any) => x.text)
  const report = { sessionId, cooperative, guideReceipt, commandCompleted: existsSync(join(workspace, 'command-finished')), steeringEvents, terminal, reply, injectedIntoInitialTurn: steeringEvents.some(x => x.type === 'turn.steerDrained' && x.turnId === terminal[0]?.params.turnId), followedInstruction: reply?.at(-1)?.trim() === 'STEER_TOKEN' }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} catch (error) {
  record('failure', String(error)); console.error(String(error)); process.exitCode = 1
} finally {
  if (existsSync(join(workspace, 'command-started')) && !existsSync(join(workspace, 'command-finished'))) {
    await until(() => existsSync(join(workspace, 'command-finished')), 35_000).catch(() => {})
  }
  if (sessionId) await call('session/close', { sessionId }, 5000).catch(() => {})
  clearTimeout(deadline); abort.abort(); child.kill()
}
