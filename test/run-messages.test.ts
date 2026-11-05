import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { canMessage } from '../src/core/executors/run-messages.js'
import { entriesFor } from '../src/main/agent-log.js'
import type { ExecutorName } from '../src/core/types.js'
import { makeWorld, until, untilState, type World } from './helpers.js'

let world: World | undefined
afterEach(async () => {
  delete process.env.FAKE_ZCODE_GUIDE_UNSUPPORTED
  delete process.env.FAKE_ZCODE_GUIDE_ACK_DELAY
  delete process.env.FAKE_RUN_GUIDE_UNSUPPORTED
  delete process.env.FAKE_RUN_GUIDE_ACK_DELAY
  delete process.env.FAKE_CLAUDE_FOLLOWUP_MS
  await world?.dispose(); world = undefined
})
const key = 'task:tsk_steer'
async function running(ms = 2500, executor: ExecutorName = 'zcode') {
  world = await makeWorld({ executor, scenario: { plan: [{ type: 'hang', ms }] } })
  world.fake.addTask('tsk_steer')
  const run = await until(() => world!.engine.store.openRuns().find(r => r.taskKey === key), r => !!r && canMessage(r), 'message channel ready')
  return run!
}
function log(file: string) { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x)) }

describe.each<ExecutorName>(['codex', 'claude', 'zcode'])('%s conversation input', executor => {
it('inserts one user message without a new run, deduplicates retries and survives a client restart', async () => {
  const run = await running(4000, executor)
  const id = randomUUID()
  await world!.engine.command('sendMessage', key, run.id, id, '请优先恢复服务，再整理文档')
  await world!.restart()
  await world!.engine.command('sendMessage', key, run.id, id, '请优先恢复服务，再整理文档')
  expect(entriesFor(executor, log(run.logPath)).filter(x => x.kind === 'user')).toEqual([
    { id: 'user-' + id, kind: 'user', text: '请优先恢复服务，再整理文档' },
  ])
  await untilState(world!, key, 'needs_you', 'plan_confirm')
  expect(world!.engine.store.runsFor(key).map(x => x.id)).toEqual([run.id])
  expect(world!.invocations()).toHaveLength(1)
  await expect(world!.engine.command('sendMessage', key, run.id, randomUUID(), 'late')).rejects.toThrow('已结束')
})

it('rejects wrong-run ownership and conflicting retry contents', async () => {
  const run = await running(2500, executor)
  await expect(world!.engine.command('sendMessage', 'task:other', run.id, randomUUID(), 'wrong')).rejects.toThrow('不属于')
  const id = randomUUID()
  await world!.engine.command('sendMessage', key, run.id, id, 'first')
  await expect(world!.engine.command('sendMessage', key, run.id, id, 'changed')).rejects.toThrow('不能更改')
})
})

describe.each<ExecutorName>(['codex', 'zcode'])('%s native steering', executor => {
it('reports unsupported steering in the conversation while the original task finishes normally', async () => {
  process.env[executor === 'zcode' ? 'FAKE_ZCODE_GUIDE_UNSUPPORTED' : 'FAKE_RUN_GUIDE_UNSUPPORTED'] = '1'
  const run = await running(2500, executor)
  await expect(world!.engine.command('sendMessage', key, run.id, randomUUID(), 'message')).rejects.toThrow('unknown method')
  await untilState(world!, key, 'needs_you', 'plan_confirm')
  expect(entriesFor(executor, log(run.logPath)).some(x => x.kind === 'error' && x.text.includes('补充指令发送失败'))).toBe(true)
  expect(world!.invocations()).toHaveLength(1)
})

it('settles an in-flight message before finishing a run whose terminal event arrives before the receipt', async () => {
  process.env[executor === 'zcode' ? 'FAKE_ZCODE_GUIDE_ACK_DELAY' : 'FAKE_RUN_GUIDE_ACK_DELAY'] = '1800'
  const run = await running(1000, executor)
  await world!.engine.command('sendMessage', key, run.id, randomUUID(), 'late receipt')
  await untilState(world!, key, 'needs_you', 'plan_confirm')
  expect(world!.engine.store.runsFor(key)).toHaveLength(1)
  expect(entriesFor(executor, log(run.logPath)).filter(x => x.kind === 'user')).toHaveLength(1)
})
})

it('keeps Claude alive and its slot occupied until an already-written follow-up finishes', async () => {
  process.env.FAKE_CLAUDE_FOLLOWUP_MS = '1500'
  const run = await running(700, 'claude')
  await world!.engine.command('sendMessage', key, run.id, randomUUID(), 'follow up')
  await until(() => log(run.logPath).some(e => e.type === 'assistant'), Boolean, 'first response')
  expect(world!.engine.store.getRun(run.id)?.endedAt).toBeNull()
  expect(log(run.logPath).some(e => e.type === 'result')).toBe(false)
  await untilState(world!, key, 'needs_you', 'plan_confirm')
  expect(world!.engine.store.runsFor(key)).toHaveLength(1)
  expect(world!.invocations()).toHaveLength(1)
})
