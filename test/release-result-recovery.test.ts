import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Task } from '../src/core/types.js'
import { makeWorld, until, untilState, type World } from './helpers.js'

let w: World | null = null
afterEach(async () => { vi.restoreAllMocks(); await w?.dispose(); w = null })
const KEY = 'task:tsk_1'
const OTHER = 'task:tsk_2'
const failed = { outcome: 'failed', deployed_sha: '', environment: 'test', summary: '核心回归未通过，未部署', verification: '旧服务健康', limitations: '须解除门禁', items: [] }
const succeeded = { ...failed, outcome: 'success', deployed_sha: 'fixture-sha', summary: '已部署并验证', limitations: '' }

async function ready(ids = ['tsk_1']) {
  for (const id of ids) {
    w!.fake.addTask(id)
    const key = 'task:' + id
    await untilState(w!, key, 'needs_you', 'plan_confirm')
    await w!.engine.command('confirmPlan', key, {})
    await untilState(w!, key, 'needs_you', 'ready_to_test')
  }
}

it.each(['failed', 'partial'])('records a %s result during a context outage and starts the next batch', async (outcome) => {
  const value = { ...failed, outcome }
  w = await makeWorld({ limit: 2, scenario: { test_release: [{ type: 'hang', ms: 700, value }] } })
  await ready(['tsk_1', 'tsk_2'])
  const first = await w.engine.command('submitTest', [KEY])
  await until(() => w!.invocations().filter((c) => c.stage === 'test_release').length, (n) => n === 1, 'release agent started')
  w.fake.brokenContext.add('tsk_1')
  const second = await w.engine.command('submitTest', [OTHER])
  const stopped = await untilState(w, first, 'needs_you', 'release_failed')
  expect(stopped.data.release).toEqual(value)
  expect(stopped.detail).toContain('核心回归未通过')
  expect(stopped.data.pendingRelease).toBeUndefined()
  expect(stopped.failures).toBe(0)
  await untilState(w, OTHER, 'waiting', 'testing')
  expect(w.task(second).status).toBe('done')
  expect(w.engine.store.openRuns().filter((r) => r.taskKey === first)).toHaveLength(0)
  expect(w.engine.store.outboxFor(KEY).filter((o) => o.tool === 'task_submit_result')).toHaveLength(0)
  expect(w.invocations().filter((c) => c.stage === 'test_release')).toHaveLength(2)
})

it('retries only a successful result across an outage and restart, without blocking another release or duplicating writes', async () => {
  w = await makeWorld({ limit: 2, scenario: { test_release: [{ type: 'hang', ms: 700 }] } })
  await ready(['tsk_1', 'tsk_2'])
  const first = await w.engine.command('submitTest', [KEY])
  await until(() => w!.invocations().filter((c) => c.stage === 'test_release').length, (n) => n === 1, 'first release started')
  w.fake.brokenContext.add('tsk_1')
  const syncing = await untilState(w, first, 'waiting', 'syncing')
  expect(syncing.data.pendingRelease?.runId).toBeTruthy()
  const run = w.engine.store.runsFor(first)[0]
  expect(run.outcome).toBe('completed')
  await until(() => w!.task(first).data.syncIssue, Boolean, 'sync error recorded')
  expect(w.task(first).lastError).toBeNull()
  expect(w.task(first).failures).toBe(0)
  await w.engine.command('submitTest', [OTHER])
  await untilState(w, OTHER, 'waiting', 'testing')
  await w.restart()
  expect(w.task(first).data.pendingRelease?.runId).toBe(run.id)
  w.fake.faults.push({ tool: 'task_submit_result', kind: 'drop_response' })
  w.fake.brokenContext.delete('tsk_1')
  await untilState(w, KEY, 'waiting', 'testing')
  const writes = w.engine.store.outboxFor(KEY).filter((o) => o.tool === 'task_submit_result')
  expect(writes).toHaveLength(1)
  expect(writes[0].status).toBe('done')
  const calls = w.fake.callsOf('task_submit_result').filter((c) => c.args.task_id === 'tsk_1')
  expect(calls.length).toBeGreaterThanOrEqual(2)
  expect(new Set(calls.map((c) => c.args.request_id)).size).toBe(1)
  expect(w.invocations().filter((c) => c.stage === 'test_release')).toHaveLength(2)
  expect(w.engine.store.getRun(run.id)).toEqual(run)
  expect(w.task(first).data.pendingRelease).toBeUndefined()
  expect(w.task(first).data.syncIssue).toBeUndefined()
  await w.restart()
  expect(w.engine.store.outboxFor(KEY).filter((o) => o.tool === 'task_submit_result')).toHaveLength(1)
})

function seedOrphan(result: unknown) {
  const store = w!.engine.store, task = w!.task(KEY), key = 'batch:legacy-orphan', stamp = new Date().toISOString()
  store.tx(() => {
    store.saveTask({ ...task, key, platformId: 'legacy-orphan', title: '旧提测', kind: 'batch', stage: 'test_release', status: 'running', reason: null,
      branch: null, worktree: null, sessions: { test_release: 'original-session' }, data: { members: [KEY], next: { purpose: 'start', schema: 'release' } } } as Task)
    store.updateTask(KEY, (t) => { t.stage = 'test_release'; t.status = 'waiting'; t.reason = 'in_batch'; t.data.batch = key })
    store.insertRun({ id: 'legacy-ended-run', taskKey: key, stage: 'test_release', purpose: 'start', schemaName: 'release', executor: 'codex',
      sessionId: 'original-session', pid: 123456, pidStart: null, logPath: join(w!.root, 'old-events.jsonl'), outPath: join(w!.root, 'old-result.txt'), startedAt: stamp })
    store.endRun('legacy-ended-run', 'completed', JSON.stringify(result), null)
  })
  return key
}

it.each(['failed', 'success'])('recovers a legacy stuck %s batch from its saved run on restart', async (outcome) => {
  w = await makeWorld()
  await ready()
  const value = outcome === 'failed' ? failed : succeeded
  const key = seedOrphan(value)
  const history = w.engine.store.getRun('legacy-ended-run')
  await w.restart()
  if (outcome === 'failed') {
    await untilState(w, key, 'needs_you', 'release_failed')
    expect(w.task(key).detail).toContain('未部署')
    expect(w.engine.store.outboxFor(KEY).filter((o) => o.tool === 'task_submit_result')).toHaveLength(0)
  } else await untilState(w, KEY, 'waiting', 'testing')
  expect(w.task(key).data.release).toEqual(value)
  expect(w.task(key).sessions.test_release).toBe('original-session')
  expect(w.engine.store.getRun('legacy-ended-run')).toEqual(history)
  expect(w.invocations().filter((c) => c.stage === 'test_release')).toHaveLength(0)
  expect(w.engine.store.events(key).filter((e) => e.type === 'release_result_recovered')).toHaveLength(1)
})

it('shows an actionable failure for a legacy orphan without a valid saved result', async () => {
  w = await makeWorld()
  await ready()
  const key = seedOrphan({ missing: 'release schema' })
  await w.restart()
  const t = await untilState(w, key, 'needs_you', 'release_failed')
  expect(t.detail).toContain('未找到可恢复的有效结果')
  expect(w.invocations().filter((c) => c.stage === 'test_release')).toHaveLength(0)
})

it('keeps pending result processing paused while the user has taken over', async () => {
  w = await makeWorld({ scenario: { test_release: [{ type: 'hang', ms: 600 }] } })
  await ready()
  const key = await w.engine.command('submitTest', [KEY])
  await until(() => w!.invocations().filter((c) => c.stage === 'test_release').length, (n) => n === 1, 'agent started')
  w.fake.brokenContext.add('tsk_1')
  await untilState(w, key, 'waiting', 'syncing')
  await w.engine.command('takeOver', key)
  w.fake.brokenContext.delete('tsk_1')
  await w.engine.scheduler.tick()
  expect(w.task(key)).toMatchObject({ status: 'needs_you', reason: 'taken_over' })
  await w.engine.command('handBack', key)
  await untilState(w, KEY, 'waiting', 'testing')
  expect(w.invocations().filter((c) => c.stage === 'test_release')).toHaveLength(1)
})

it('records a production release failure even when its member context cannot be read', async () => {
  w = await makeWorld({ scenario: { release: [{ type: 'hang', ms: 700, value: { ...failed, environment: 'production' } }] } })
  await ready()
  await w.engine.command('submitTest', [KEY])
  await untilState(w, KEY, 'waiting', 'testing')
  w.fake.passTest('tsk_1')
  await untilState(w, KEY, 'needs_you', 'ready_to_release')
  const key = await w.engine.command('release', [KEY])
  await until(() => w!.invocations().filter((c) => c.stage === 'release').length, (n) => n === 1, 'production release started')
  w.fake.brokenContext.add('tsk_1')
  const stopped = await untilState(w, key, 'needs_you', 'release_failed')
  expect(stopped.data.release).toMatchObject({ outcome: 'failed', environment: 'production' })
  expect(w.fake.callsOf('task_mark_deployed')).toHaveLength(0)
  expect(w.invocations().filter((c) => c.stage === 'release')).toHaveLength(1)
})

it('retries a rolled-back result transaction without duplicate platform writes or mixing it with sync faults', async () => {
  w = await makeWorld({ scenario: { test_release: [{ type: 'hang', ms: 600 }] } })
  await ready()
  const key = await w.engine.command('submitTest', [KEY])
  const original = w.engine.store.enqueue.bind(w.engine.store)
  let failedOnce = false
  vi.spyOn(w.engine.store, 'enqueue').mockImplementation((item) => {
    if (item.tool === 'task_submit_result' && !failedOnce) { failedOnce = true; throw new Error('local result transaction failed') }
    return original(item)
  })
  await untilState(w, KEY, 'waiting', 'testing')
  expect(failedOnce).toBe(true)
  expect(w.engine.store.events(key).some((e) => e.type === 'retry' && e.message.includes('local result transaction failed'))).toBe(true)
  expect(w.engine.store.events(key).some((e) => e.type === 'sync_error')).toBe(false)
  expect(w.engine.store.outboxFor(KEY).filter((o) => o.tool === 'task_submit_result')).toHaveLength(1)
  expect(w.invocations().filter((c) => c.stage === 'test_release')).toHaveLength(1)
  expect(w.task(key).lastError).toBeNull()
})
