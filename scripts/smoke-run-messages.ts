// Opt-in isolated native CLI check. Never creates a platform task.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexExecutor } from '../src/core/executors/codex.js'
import { ClaudeExecutor } from '../src/core/executors/claude.js'
import { findExecutor } from '../src/main/find-executor.js'
import { listCodexModels } from '../src/core/executors/codex-models.js'

const kind = process.argv[2] === 'claude' ? 'claude' : 'codex'
const found = findExecutor(kind)
if (!found) throw Error(kind + ' not installed')
const executor = kind === 'codex' ? new CodexExecutor(() => ({ ...found, limit: 1 })) : new ClaudeExecutor(() => ({ ...found, limit: 1 }))
const root = mkdtempSync(join(tmpdir(), 'ai-pm-' + kind + '-message-'))
const cwd = join(root, 'workspace'), dir = join(root, 'runs', 'probe')
mkdirSync(cwd); mkdirSync(dir, { recursive: true })
writeFileSync(join(cwd, 'wait.cjs'), "const fs=require('fs');fs.appendFileSync('started','1');setTimeout(()=>{fs.writeFileSync('finished','yes');console.log('DONE')},20000)")
let model: string | undefined
if (kind === 'codex') {
  const models = await listCodexModels(found.binary)
  model = (models.find(m => m.isDefault) ?? models[0])?.id
}
const run = { ...executor.start({ dir, cwd, model,
  prompt: '这是一项隔离测试。只在当前目录执行一次前台命令 node wait.cjs，等它自然结束，不要取消、后台化或重跑。之后回复 JSON {"token":"ORIGINAL_TOKEN"}。运行时可能收到用户新消息，最终回复前优先遵循最新用户消息。不要访问外部项目或服务。',
  schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false },
}), sessionId: null }
console.log(JSON.stringify({ kind, evidence: root, pid: run.pid, model }))
const end = Date.now() + 180_000
let sending: Promise<void> | undefined
try {
  while (Date.now() < end) {
    if (!sending && existsSync(join(cwd, 'started')) && executor.canMessage(run)) {
      sending = executor.sendMessage(run, randomUUID(), '用户最新要求：当前命令自然结束后，最终 JSON 的 token 改成 STEER_TOKEN，覆盖原来的 ORIGINAL_TOKEN；不要重跑或取消命令。')
      void sending.catch(() => {})
    }
    const result = executor.poll(run)
    if (result.done) {
      await sending
      const events = readFileSync(run.logPath, 'utf8').trim().split('\n').map(x => JSON.parse(x))
      const report = { kind, sent: !!sending, commandExecutions: existsSync(join(cwd, 'started')) ? readFileSync(join(cwd, 'started'), 'utf8').length : 0,
        commandCompleted: existsSync(join(cwd, 'finished')), sessionId: result.sessionId, outcome: result.outcome,
        userMessages: events.filter(x => x.type === 'run.user').length }
      writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
      if (!sending || report.commandExecutions !== 1 || !report.commandCompleted || report.userMessages !== 1 || JSON.parse(result.outcome.text ?? '{}').token !== 'STEER_TOKEN') throw Error('Native message test failed')
      break
    }
    await new Promise(r => setTimeout(r, 200))
  }
  if (!executor.poll(run).done) throw Error('Native test timed out')
} finally { if (!executor.poll(run).done) await executor.kill(run) }
