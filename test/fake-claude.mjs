#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`, playing the scenarios in fake-agent.mjs.
import { randomUUID } from 'node:crypto'
import { play } from './fake-agent.mjs'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('2.0.0-fake (Claude Code)')
  process.exit(0)
}
const options = {}
const allowed = []
let prompt = ''
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--') {
    prompt = args.slice(i + 1).join(' ')
    break
  }
  if (arg === '--allowedTools') {
    while (args[i + 1] && !args[i + 1].startsWith('-')) allowed.push(args[++i])
  } else if (['--output-format', '--json-schema', '--resume', '--session-id', '--model', '--effort', '--permission-mode', '--setting-sources', '--mcp-config'].includes(arg)) {
    options[arg] = args[++i]
  } else if (!arg.startsWith('-')) prompt = arg
}
const resumed = Boolean(options['--resume'])
const session = options['--resume'] ?? options['--session-id'] ?? randomUUID()
const readOnly = options['--permission-mode'] === 'dontAsk'
const config = Object.entries(options).filter(([k]) => k !== '--json-schema').map(([k, v]) => `${k}=${v}`)
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')
const action = play({ executor: 'claude', prompt, cwd: process.cwd(), session, resumed, readOnly, config: [...config, ...allowed.map((t) => 'allow=' + t)] })
emit({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), model: options['--model'] ?? 'fake', permissionMode: options['--permission-mode'] })

function finish(text) {
  emit({ type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'text', text }] } })
  let structured
  try {
    structured = JSON.parse(text)
  } catch {
    // Prose: real Claude Code would keep asking; the fake hands it back as the result text.
  }
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: text, ...(structured ? { structured_output: structured } : {}) })
}

if (action.type === 'crash') process.exit(3)
else if (action.type === 'fail') {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, result: action.message })
  process.exit(1)
} else if (action.type === 'hang') setTimeout(() => finish(action.text()), action.ms)
else finish(action.text)
