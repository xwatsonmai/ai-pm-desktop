#!/usr/bin/env node
// Stand-in for `codex exec --json`. It reads the [ai-pm stage=… purpose=…] marker on
// the prompt's first line and plays the next scripted behaviour for that stage.
// FAKE_CODEX_SCENARIO: JSON file {stage: [behaviour, ...]}; FAKE_CODEX_LOG: JSONL of invocations.
import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('codex-cli 0.0.0-fake')
  process.exit(0)
}
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
const resumed = Boolean(session)
session ??= randomUUID()
const cwd = options['-C'] ?? process.cwd()
const marker = /\[ai-pm stage=(\w+) purpose=(\w+)/.exec(prompt) ?? []
const stage = marker[1] ?? 'unknown'
const purpose = marker[2] ?? 'unknown'
const readOnly = (options.c ?? []).includes('sandbox_mode="read-only"')

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n')
const git = (cmd) => execSync('git ' + cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function nextBehaviour() {
  const path = process.env.FAKE_CODEX_SCENARIO
  if (!path || !existsSync(path)) return { type: 'ok' }
  const scenario = JSON.parse(readFileSync(path, 'utf8'))
  const cursorPath = path + '.cursor.json'
  const cursor = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, 'utf8')) : {}
  const key = purpose === 'alignment' ? 'alignment' : stage
  const index = cursor[key] ?? 0
  cursor[key] = index + 1
  writeFileSync(cursorPath + '.tmp', JSON.stringify(cursor))
  renameSync(cursorPath + '.tmp', cursorPath)
  return (scenario[key] ?? [])[index] ?? { type: 'ok' }
}

function defaultResult(behaviour) {
  if (purpose === 'alignment') return { decision: 'resume', body: '已阅读产品回复，可以继续开发', questions: [] }
  switch (stage) {
    case 'plan':
      return {
        summary: '方案摘要', plan: '1. 修改代码\n2. 补测试', tests: '单元测试', risks: '无',
        business_questions: [], technical_findings: [{ topic: '现状', conclusion: '已有模块可复用', evidence: 'src/index.js' }],
      }
    case 'develop': {
      const status = behaviour.type === 'needs_alignment' ? 'needs_alignment' : behaviour.type === 'needs_user' ? 'needs_user' : 'done'
      if (status === 'done') {
        const name = 'work-' + randomUUID().slice(0, 6) + '.txt'
        writeFileSync(cwd + '/' + name, 'change\n')
        if (behaviour.type !== 'dirty') {
          git('add -A')
          git(`commit -q -m "implement ${name}"`)
        }
      }
      return {
        status, summary: '已实现需求', sha: git('rev-parse HEAD'), tests: 'npm test 通过', limitations: '',
        message: status === 'done' ? '' : '需要确认：退款计入哪个月？',
        alignment_questions: status === 'needs_alignment' ? [{ title: '退款计入哪个月？', detail: '下单月或退款月' }] : [],
      }
    }
    case 'test_release':
    case 'release':
      return {
        outcome: 'success', deployed_sha: git('rev-parse HEAD'), environment: stage === 'release' ? 'production' : 'test',
        summary: '已发布', verification: '健康检查通过', limitations: '', items: [],
      }
    case 'collab':
      return {
        outcome: 'confirmed', summary: '查到原因', environment: 'production', observed_at: new Date().toISOString(),
        deployment_version: 'v1', limitations: '无', evidence: '日志第 10 行',
      }
    default:
      return {}
  }
}

const behaviour = nextBehaviour()
if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ stage, purpose, session, resumed, cwd, readOnly, behaviour: behaviour.type }) + '\n')
}
emit({ type: 'thread.started', thread_id: session })
emit({ type: 'turn.started' })

function finish(text) {
  if (options['-o']) writeFileSync(options['-o'], text)
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } })
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
}

switch (behaviour.type) {
  case 'crash':
    process.exit(3)
    break
  case 'fail':
    emit({ type: 'turn.failed', error: { message: behaviour.message ?? 'usage limit reached' } })
    process.exit(1)
    break
  case 'invalid':
    finish('我已经完成了，结果见上文。')
    break
  case 'hang':
    setTimeout(() => finish(JSON.stringify(defaultResult(behaviour))), behaviour.ms ?? 60_000)
    break
  case 'result':
    finish(JSON.stringify(behaviour.value))
    break
  default:
    finish(JSON.stringify(defaultResult(behaviour)))
}
