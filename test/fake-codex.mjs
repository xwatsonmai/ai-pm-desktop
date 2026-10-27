#!/usr/bin/env node
// Stand-in for `codex exec --json`, playing the scenarios in fake-agent.mjs.
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\n')
    if (message.method === 'model/list') process.stdout.write(JSON.stringify({ id: message.id, result: pages[message.params.cursor ?? 'first'] }) + '\n')
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
const action = play({ executor: 'codex', prompt, cwd, session, resumed, fullAccess, config: options.c ?? [] })
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
