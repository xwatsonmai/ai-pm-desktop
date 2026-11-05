#!/usr/bin/env node
// Stand-in for `codex exec --json`, playing the scenarios in fake-agent.mjs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { play } from './fake-agent.mjs'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('codex-cli 0.0.0-fake')
  process.exit(0)
}
// The model catalog over app-server, split over two pages like a long list.
if (args[0] === 'app-server') {
  const { createInterface } = await import('node:readline')
  const pages = {
    first: { data: [{ id: 'fake-pro', model: 'fake-pro', displayName: 'Fake Pro', isDefault: true, defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'max' }] }], nextCursor: 'p2' },
    p2: { data: [{ id: 'fake-mini', model: 'fake-mini', displayName: 'Fake Mini', isDefault: false, defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null },
  }
  let session, options = {}, turnId
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')
  const response = (id, result) => emit({ id, result })
  const notify = (method, params) => emit({ method, params: { threadId: session, ...params } })
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    const p = message.params ?? {}
    if (message.method === 'initialize') response(message.id, { userAgent: 'fake' })
    if (message.method === 'model/list') response(message.id, pages[p.cursor ?? 'first'])
    if (message.method === 'getAuthStatus') response(message.id, { authMethod: 'chatgpt', authToken: 'header.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fake-account' } })).toString('base64url') + '.signature' })
    if (message.method === 'account/login/start') response(message.id, { type: 'chatgptAuthTokens' })
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      // The real Windows CLI writes this on the first trusted workspace.
      // Never write into the developer's original Codex home during tests.
      if (process.env.CODEX_HOME && basename(process.env.CODEX_HOME) === 'codex-runtime') {
        const file = join(process.env.CODEX_HOME, 'config.toml')
        if (!existsSync(file)) writeFileSync(file, `[projects.${JSON.stringify(p.cwd)}]\ntrust_level = "trusted"\n`)
      }
      session = p.threadId ?? randomUUID()
      options = { ...p, resumed: !!p.threadId }
      response(message.id, { thread: { id: session } })
    }
    if (message.method === 'turn/start') {
      turnId = randomUUID()
      response(message.id, { turn: { id: turnId } })
      notify('turn/started', { turn: { id: turnId } })
      const config = args.flatMap((x, i) => x === '-c' && !/^(cli_auth_credentials_store|sqlite_home)=/.test(args[i + 1]) ? [args[i + 1]] : [])
      const action = play({ executor: 'codex', prompt: p.input.map(x => x.text).join('\n'), cwd: options.cwd ?? process.cwd(), session, resumed: options.resumed,
        fullAccess: options.sandbox === 'danger-full-access' && options.approvalPolicy === 'never', model: options.model, config })
      const finish = (text) => {
        notify('item/completed', { item: { id: 'final', type: 'agentMessage', text, phase: 'final_answer' } })
        notify('turn/completed', { turn: { id: turnId, status: 'completed' } })
      }
      if (action.type === 'crash') process.exit(3)
      else if (action.type === 'fail') notify('turn/completed', { turn: { id: turnId, status: 'failed', error: { message: action.message } } })
      else if (action.type === 'hang') setTimeout(() => finish(action.text()), action.ms)
      else finish(action.text)
    }
    if (message.method === 'turn/steer') {
      if (process.env.FAKE_RUN_GUIDE_UNSUPPORTED) emit({ id: message.id, error: { code: -32601, message: 'unknown method turn/steer' } })
      else setTimeout(() => response(message.id, { turnId }), Number(process.env.FAKE_RUN_GUIDE_ACK_DELAY ?? 0))
    }
  })
}
else {
let i = 1
let session = null
if (args[1] === 'resume') {
  session = args[2]
  i = 3
}
const options = {}
const flags = new Set()
let prompt = ''
for (; i < args.length; i++) {
  const arg = args[i]
  if (['--output-schema', '-o', '-C', '-m', '-c'].includes(arg)) {
    const value = args[++i]
    if (arg === '-c') (options.c ??= []).push(value)
    else options[arg] = value
  } else if (arg.startsWith('-')) flags.add(arg)
  else prompt = arg
}
// `-` (or no prompt): read it from stdin, as the client sends it.
if (!prompt || flags.has('-')) prompt = readFileSync(0, 'utf8')
const resumed = Boolean(session)
session ??= randomUUID()
const cwd = options['-C'] ?? process.cwd()
const fullAccess = flags.has('--dangerously-bypass-approvals-and-sandbox')
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')
const action = play({ executor: 'codex', prompt, cwd, session, resumed, fullAccess, model: options['-m'], config: options.c ?? [] })
emit({ type: 'thread.started', thread_id: session })
emit({ type: 'turn.started' })

function finish(text) {
  if (options['-o']) writeFileSync(options['-o'], text)
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } })
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
}

if (action.type === 'crash') process.exit(3)
else if (action.type === 'fail') {
  emit({ type: 'turn.failed', error: { message: action.message } })
  process.exit(1)
} else if (action.type === 'hang') setTimeout(() => finish(action.text()), action.ms)
else finish(action.text)
}
