// Opt-in integration check of the actual detached runner and durable mailbox.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ZCodeExecutor } from '../src/core/executors/zcode.js'
import { findExecutor } from '../src/main/find-executor.js'

const root = mkdtempSync(join(tmpdir(), 'ai-pm-message-smoke-'))
const cwd = join(root, 'workspace'), dir = join(root, 'run')
mkdirSync(cwd); mkdirSync(dir)
writeFileSync(join(cwd, 'wait.cjs'), "const fs=require('fs');fs.writeFileSync('started','yes');setTimeout(()=>{fs.writeFileSync('finished','yes');console.log('DONE')},30000)")
const found = findExecutor('zcode')
if (!found) throw Error('ZCode not installed')
const executor = new ZCodeExecutor(() => ({ ...found, limit: 1 }))
const run = { ...executor.start({ dir, cwd,
  prompt: '这是一项隔离测试，只在当前目录工作，不访问任何外部项目或服务。执行一次前台命令 node wait.cjs，等待它自然结束，不要取消、后台化或重跑。之后回复 JSON {"token":"ORIGINAL_TOKEN"}。命令运行时可能收到新的用户补充，请在最终回复前优先遵循最新用户消息。',
  schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false },
}), sessionId: null }
console.log(JSON.stringify({ evidence: root, pid: run.pid }))
const end = Date.now() + 180_000
let sent = false
try {
  while (Date.now() < end) {
    if (!sent && existsSync(join(cwd, 'started')) && executor.canMessage(run)) {
      await executor.sendMessage(run, randomUUID(), '用户最新要求：不要取消或重跑当前命令。命令自然结束后，将最终 JSON 的 token 改成 STEER_TOKEN，覆盖原来的 ORIGINAL_TOKEN。')
      sent = true
    }
    const result = executor.poll(run)
    if (result.done) {
      const reply = result.outcome.text ? JSON.parse(result.outcome.text) : null
      const events = readFileSync(run.logPath, 'utf8').trim().split('\n').map(x => JSON.parse(x))
      const turns = events.filter(x => x.event?.type === 'turn.started').map(x => x.event.turnId)
      const report = { sent, commandCompleted: existsSync(join(cwd, 'finished')), turns, reply, outcome: result.outcome.kind,
        userMessages: events.filter(x => x.type === 'zcode.user').length,
        drainedIntoOriginalTurn: events.some(x => x.event?.type === 'turn.steerDrained' && x.event.turnId === turns[0]) }
      writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
      console.log(JSON.stringify(report))
      if (!sent || !report.commandCompleted || turns.length !== 1 || report.userMessages !== 1 || !report.drainedIntoOriginalTurn || reply?.token !== 'STEER_TOKEN') throw Error('Message integration check failed: see report')
      break
    }
    await new Promise(r => setTimeout(r, 200))
  }
  if (!executor.poll(run).done) throw Error('Probe deadline reached')
} finally { if (!executor.poll(run).done) await executor.kill(run) }
