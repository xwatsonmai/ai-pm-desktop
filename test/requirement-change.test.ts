import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PlatformError } from '../src/core/platform/client.js'
import { makeWorld, until, untilState, type World } from './helpers.js'

let w: World | null = null
afterEach(async () => { await w?.dispose(); w = null })
const KEY = 'task:tsk_1'
const failed = { type: 'result', value: { outcome: 'failed', deployed_sha: '', environment: 'production', summary: '等待发布确认', verification: '', limitations: '未部署', items: [] } }

async function ready(ids = ['tsk_1']) {
  for (const id of ids) w!.fake.addTask(id)
  for (const id of ids) {
    const key = 'task:' + id
    await untilState(w!, key, 'needs_you', 'plan_confirm')
    await w!.engine.command('confirmPlan', key, {})
    await untilState(w!, key, 'needs_you', 'ready_to_test')
  }
  await w!.engine.command('submitTest', ids.map((id) => 'task:' + id))
  for (const id of ids) {
    await untilState(w!, 'task:' + id, 'waiting', 'testing')
    w!.fake.passTest(id)
    await untilState(w!, 'task:' + id, 'needs_you', 'ready_to_release')
  }
}

it.each([false, true])('resumes a confirmed change from ready-to-release, including an already-consumed revision (%s)', async (consumed) => {
  w = await makeWorld()
  await ready()
  const before = w.task(KEY)
  w.fake.notifyEnabled = false
  w.fake.confirmRequirementChange('tsk_1')
  if (consumed) {
    // 0.1.4 had saved the new revision without applying its transition.
    await w.engine.scheduler.refreshTask(w.task(KEY))
    expect(w.task(KEY)).toMatchObject({ stage: 'release', revision: 2 })
    await w.restart()
  } else await w.engine.scheduler.reconcile()
  const after = await untilState(w, KEY, 'needs_you', 'ready_to_test')
  expect(after).toMatchObject({ stage: 'develop', revision: 2, claimId: before.claimId, branch: before.branch, worktree: before.worktree, models: before.models })
  expect(after.sessions.develop).toBe(before.sessions.develop)
  expect(after.data.submittedSha).toBeNull()
  expect(after.data.planApproval).toBeNull()
  expect(JSON.parse(readFileSync(join(after.worktree!, '.ai-pm/plan.json'), 'utf8'))).toBeNull()
  const context = JSON.parse(readFileSync(join(after.worktree!, '.ai-pm/task.json'), 'utf8'))
  expect(context.task.revision).toBe(2)
  expect(context.task.brief).toContain('变更已确认')
  const calls = w.invocations().filter((c) => c.stage === 'develop')
  expect(calls).toHaveLength(2)
  expect(calls[1]).toMatchObject({ purpose: 'continue', session: calls[0].session })
  await w.engine.scheduler.reconcile()
  expect(w.task(KEY)).toMatchObject({ status: 'needs_you', reason: 'ready_to_test' })
  expect(w.engine.store.events(KEY).filter((e) => e.type === 'requirement_change_resumed')).toHaveLength(1)
})

it('closes an obsolete paused release, keeps its history, and blocks stale release buttons', async () => {
  w = await makeWorld({ scenario: { release: [failed] } })
  await ready()
  const batch = await w.engine.command('release', [KEY])
  await untilState(w, batch, 'needs_you', 'release_failed')
  const history = w.engine.store.runsFor(batch)
  w.fake.notifyEnabled = false
  w.fake.confirmRequirementChange('tsk_1')
  // The button must refresh first, even before the subscription/poll arrives.
  await expect(w.engine.command('continueRelease', batch)).rejects.toMatchObject({ code: 'wrong_state' })
  expect(w.task(batch)).toMatchObject({ status: 'closed', reason: null, data: { members: [KEY] } })
  expect(w.engine.store.runsFor(batch)).toEqual(history)
  expect(w.task(KEY).data.batch).toBeNull()
  await expect(w.engine.command('markReleased', batch, '已上线')).rejects.toMatchObject({ code: 'wrong_state' })
  await expect(w.engine.command('abandonBatch', batch)).rejects.toMatchObject({ code: 'wrong_state' })
  await untilState(w, KEY, 'needs_you', 'ready_to_test')
  expect(w.fake.callsOf('task_mark_deployed')).toHaveLength(0)
  expect(w.invocations().filter((c) => c.stage === 'release')).toHaveLength(1)
})

it('excludes only the changed member from a paused batch and publishes the others', async () => {
  w = await makeWorld({ limit: 2, scenario: { release: [failed] } })
  await ready(['tsk_1', 'tsk_2'])
  const other = 'task:tsk_2'
  const batch = await w.engine.command('release', [KEY, other])
  await untilState(w, batch, 'needs_you', 'release_failed')
  const before = w.task(other)
  w.fake.confirmRequirementChange('tsk_1')
  await untilState(w, KEY, 'needs_you', 'ready_to_test')
  expect(w.task(other)).toMatchObject({ stage: before.stage, status: before.status, reason: before.reason, data: { batch } })
  await w.engine.command('continueRelease', batch)
  await untilState(w, other, 'waiting', 'acceptance')
  expect(w.task(KEY)).toMatchObject({ status: 'needs_you', reason: 'ready_to_test', data: { batch: null } })
  const items = JSON.parse(readFileSync(join(w.engine.scheduler.checkoutDir(w.task(batch)), '.ai-pm/release.json'), 'utf8')).items
  expect(items.map((x: any) => x.task_id)).toEqual(['tsk_2'])
  expect(w.fake.callsOf('task_mark_deployed').map((c) => c.args.task_id)).toEqual(['tsk_2'])
  expect(w.task(batch).data.members).toEqual([KEY, other])
})

it('does not resume before confirmation or publish while a change is under review', async () => {
  w = await makeWorld()
  await ready()
  w.fake.notifyEnabled = false
  w.fake.update('tsk_1', (t) => { t.status = 'clarify'; t.requirement_change = { status: 'reviewing', base_revision: 1 } })
  await expect(w.engine.command('release', [KEY])).rejects.toMatchObject({ code: 'wrong_state' })
  expect(w.task(KEY)).toMatchObject({ stage: 'release', status: 'needs_you', reason: 'ready_to_release' })
  expect(w.invocations().filter((c) => c.stage === 'develop')).toHaveLength(1)
  w.fake.confirmRequirementChange('tsk_1')
  await w.engine.scheduler.reconcile()
  await untilState(w, KEY, 'needs_you', 'ready_to_test')
})

it('waits for the active release run to end, then ignores its obsolete completion', async () => {
  w = await makeWorld({ scenario: { release: [{ type: 'hang', ms: 900 }] } })
  await ready()
  const batch = await w.engine.command('release', [KEY])
  const run = await until(() => w!.engine.store.openRuns().find((r) => r.taskKey === batch), Boolean, 'release running')
  w.fake.confirmRequirementChange('tsk_1')
  await w.engine.scheduler.reconcile()
  expect(w.task(KEY)).toMatchObject({ status: 'waiting', reason: 'in_batch', data: { batch } })
  expect(w.engine.store.openRuns().some((r) => r.id === run!.id)).toBe(true)
  await untilState(w, KEY, 'needs_you', 'ready_to_test')
  expect(w.task(batch).status).toBe('closed')
  expect(w.engine.store.runsFor(batch)[0].outcome).toBe('completed')
  expect(w.fake.callsOf('task_mark_deployed')).toHaveLength(0)
})

it('preserves manual takeover until the user hands the task back', async () => {
  w = await makeWorld()
  await ready()
  await w.engine.command('takeOver', KEY)
  w.fake.confirmRequirementChange('tsk_1')
  await w.engine.scheduler.reconcile()
  expect(w.task(KEY)).toMatchObject({ stage: 'release', status: 'needs_you', reason: 'taken_over' })
  await w.engine.command('handBack', KEY)
  await untilState(w, KEY, 'needs_you', 'ready_to_test')
})

it('refreshes before manually marking a paused release complete', async () => {
  w = await makeWorld({ scenario: { release: [failed] } })
  await ready()
  const batch = await w.engine.command('release', [KEY])
  await untilState(w, batch, 'needs_you', 'release_failed')
  w.fake.notifyEnabled = false
  w.fake.confirmRequirementChange('tsk_1')
  await expect(w.engine.command('markReleased', batch, '已完成')).rejects.toMatchObject({ code: 'wrong_state' })
  await untilState(w, KEY, 'needs_you', 'ready_to_test')
  expect(w.fake.callsOf('task_mark_deployed')).toHaveLength(0)
})

it('recovers a confirmed change from a paused test release without looping on its next test release', async () => {
  w = await makeWorld({ scenario: { test_release: [failed] } })
  w.fake.addTask('tsk_1')
  await untilState(w, KEY, 'needs_you', 'plan_confirm')
  await w.engine.command('confirmPlan', KEY, {})
  await untilState(w, KEY, 'needs_you', 'ready_to_test')
  const batch = await w.engine.command('submitTest', [KEY])
  await untilState(w, batch, 'needs_you', 'release_failed')
  w.fake.confirmRequirementChange('tsk_1')
  await untilState(w, KEY, 'needs_you', 'ready_to_test')
  expect(w.task(batch).status).toBe('closed')
  await w.engine.command('submitTest', [KEY])
  await untilState(w, KEY, 'waiting', 'testing')
  expect(w.invocations().filter((c) => c.stage === 'develop')).toHaveLength(2)
})

it('retains an old outbox request and receipt without letting it overwrite new development', async () => {
  w = await makeWorld()
  await ready()
  const before = w.task(KEY)
  w.fake.confirmRequirementChange('tsk_1')
  await untilState(w, KEY, 'needs_you', 'ready_to_test')
  const id = w.engine.store.enqueue({ taskKey: KEY, tool: 'task_mark_deployed', params: { task_id: 'tsk_1', claim_id: before.claimId, revision: 1, sha: before.data.submittedSha }, effect: 'deployed' })
  const item = w.engine.store.getOutbox(id)!
  const params = structuredClone(item.params)
  w.engine.store.outboxDone(id, { task: { status: 'review', version: 1 } })
  w.engine.scheduler.outboxHandlers.onDone(item, { task: { status: 'review', version: 1 } })
  w.engine.scheduler.outboxHandlers.onRejected(item, new PlatformError('rejected', 'revision_mismatch'))
  expect(w.task(KEY)).toMatchObject({ status: 'needs_you', reason: 'ready_to_test', revision: 2, data: { submittedSha: null } })
  expect(w.engine.store.getOutbox(id)).toMatchObject({ status: 'done', params })
})
