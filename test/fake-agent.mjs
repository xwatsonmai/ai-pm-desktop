// Scripted agent behaviour shared by the fake Codex, Claude Code and ZCode CLIs.
// The [ai-pm stage=… purpose=…] marker on the prompt's first line picks the stage;
// FAKE_CODEX_SCENARIO is a JSON file {stage: [behaviour, ...]} played in order, and
// every invocation is appended to FAKE_CODEX_LOG.
import { execSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export function nextBehaviour(stage, purpose) {
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

function defaultResult(behaviour, stage, purpose, git, cwd) {
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
        // behaviour.file makes every run edit the same file, so two fixes conflict.
        const name = behaviour.file ?? 'work-' + randomUUID().slice(0, 6) + '.txt'
        writeFileSync(cwd + '/' + name, behaviour.file ? randomUUID() + '\n' : 'change\n')
        if (behaviour.type !== 'dirty') {
          git('add -A')
          git(`commit -q -m "implement ${name}"`)
        }
      }
      return {
        status, summary: '已实现需求', sha: git('rev-parse HEAD'), tests: behaviour.tests ?? 'npm test 通过', limitations: '',
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

// Plays the next behaviour for this prompt. Returns what the agent should do:
// { type: 'crash' | 'fail' | 'hang' | 'reply', text?, message?, ms? }.
export function play({ executor, prompt, cwd, session, resumed, readOnly, config = [] }) {
  const marker = /\[ai-pm stage=(\w+) purpose=(\w+)/.exec(prompt) ?? []
  const stage = marker[1] ?? 'unknown'
  const purpose = marker[2] ?? 'unknown'
  const git = (cmd) => execSync('git ' + cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const behaviour = nextBehaviour(stage, purpose)
  if (process.env.FAKE_CODEX_LOG) {
    appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ executor, stage, purpose, session, resumed, cwd, readOnly, config, behaviour: behaviour.type, prompt }) + '\n')
  }
  const result = () => defaultResult(behaviour, stage, purpose, git, cwd)
  switch (behaviour.type) {
    case 'crash':
      return { type: 'crash' }
    case 'fail':
      return { type: 'fail', message: behaviour.message ?? 'usage limit reached' }
    case 'invalid':
      return { type: 'reply', text: '我已经完成了，结果见上文。' }
    case 'hang':
      return { type: 'hang', ms: behaviour.ms ?? 60_000, text: () => JSON.stringify(result()) }
    case 'result':
      return { type: 'reply', text: JSON.stringify(behaviour.value) }
    default:
      return { type: 'reply', text: JSON.stringify(result()) }
  }
}
