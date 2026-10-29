import { afterEach, describe, expect, it } from 'vitest'
import { fakeExecutor, makeWorld, until, untilState, type World } from './helpers.js'

let world: World | null = null
afterEach(async () => { await world?.dispose(); world = null })
const KEY = 'task:tsk_1'
const models = { expert: { model: 'new-expert', effort: 'high' }, execution: { model: 'new-execution', effort: 'medium' } }

async function failed(reason: 'executor_failing' | 'output_invalid' = 'executor_failing') {
  world = await makeWorld({ executor: 'zcode', scenario: { plan: Array.from({ length: 3 }, () => ({ type: reason === 'output_invalid' ? 'invalid' : 'fail' })) }, settings: {
    executors: { zcode: fakeExecutor('zcode'), codex: { ...fakeExecutor('codex'), models } }, allowedExecutors: ['zcode'],
  } })
  world.fake.addTask('tsk_1')
  return untilState(world, KEY, 'needs_you', reason)
}

describe('explicit retry executor handoff', () => {
  it.each(['executor_failing', 'output_invalid'] as const)('reassigns %s to a configured executor even with new intake disabled', async (reason) => {
    const before = await failed(reason)
    const w = world!
    const oldRuns = w.engine.store.runsFor(KEY)
    await w.engine.command('retry', KEY, 'codex')
    const after = await untilState(w, KEY, 'needs_you', 'plan_confirm')
    expect(after).toMatchObject({ executor: 'codex', models, worktree: before.worktree, branch: before.branch, claimId: before.claimId, platformId: before.platformId })
    expect(after.sessions.plan).not.toBe(before.sessions.plan)
    expect(after.failures).toBe(0)
    expect(after.lastError).toBeNull()
    expect(w.engine.store.runsFor(KEY).slice(0, oldRuns.length)).toEqual(oldRuns)
    expect(w.fake.callsOf('task_claim')).toHaveLength(1)
    const call = w.invocations().at(-1)
    expect(call).toMatchObject({ executor: 'codex', purpose: 'start', resumed: false })
    expect(call.model).toBe('new-expert')
    expect(call.config).toContain('model_reasoning_effort="high"')
    expect(call.prompt).toContain('用户将任务从 ZCode 交给 Codex 重试')
    expect(call.prompt).toContain('不要覆盖已有成果')
    expect(w.engine.store.getSettings()!.allowedExecutors).toEqual(['zcode'])
  })

  it('does not mutate a task when the requested executor is unavailable', async () => {
    const before = await failed()
    for (const executor of ['claude', 'invalid']) {
      await expect(world!.engine.command('retry', KEY, executor as 'claude')).rejects.toMatchObject({ code: 'executor_unavailable' })
      expect(world!.task(KEY)).toEqual(before)
    }
  })

  it('keeps the old session when retrying the same executor', async () => {
    const before = await failed()
    await world!.engine.command('retry', KEY, 'zcode')
    const after = await untilState(world!, KEY, 'needs_you', 'plan_confirm')
    expect(after.sessions.plan).toBe(before.sessions.plan)
    expect(world!.invocations().at(-1)).toMatchObject({ executor: 'zcode', purpose: 'resume', resumed: true })
  })

  it('queues reassigned work behind the new executor slot and rejects retry during an active run', async () => {
    await failed()
    const w = world!
    // Another task is already using Codex; intake policy is independent of a manual handoff.
    w.engine.store.setSettings({ ...w.engine.store.getSettings()!, allowedExecutors: ['codex'] })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(w.scenarioPath, JSON.stringify({ plan: [{}, {}, {}, { type: 'hang', ms: 1_800 }] }))
    w.fake.addTask('tsk_2')
    await untilState(w, 'task:tsk_2', 'running')
    await until(() => w.invocations().length, (n) => n === 4, 'second agent launched')
    await expect(w.engine.command('retry', 'task:tsk_2', 'zcode')).rejects.toMatchObject({ code: 'wrong_state' })
    await w.engine.command('retry', KEY, 'codex')
    expect(w.task(KEY).status).toBe('queued')
    await new Promise((r) => setTimeout(r, 180))
    expect(w.task(KEY).status).toBe('queued')
    expect(w.invocations()).toHaveLength(4)
    await untilState(w, KEY, 'needs_you', 'plan_confirm')
    expect(w.invocations().at(-1)).toMatchObject({ executor: 'codex', purpose: 'start' })
  })

  it('changes only the reviewer on a failed review, preserving development ownership and sessions', async () => {
    world = await makeWorld({ scenario: { review: [{ type: 'fail' }, { type: 'fail' }, { type: 'fail' }] }, settings: {
      executors: { codex: fakeExecutor('codex'), zcode: fakeExecutor('zcode'), claude: { ...fakeExecutor('claude'), models } }, allowedExecutors: ['codex'],
    } })
    const w = world
    w.fake.addTask('tsk_1')
    await untilState(w, KEY, 'needs_you', 'plan_confirm')
    await w.engine.command('confirmPlan', KEY, {})
    await untilState(w, KEY, 'needs_you', 'ready_to_test')
    await w.engine.command('startReview', KEY, 'zcode')
    const before = await untilState(w, KEY, 'needs_you', 'executor_failing')
    await w.engine.command('retry', KEY, 'claude')
    const after = await untilState(w, KEY, 'needs_you', 'review_ready')
    expect(after).toMatchObject({ executor: 'codex', models: before.models, data: { reviewer: 'claude', dev: before.data.dev } })
    expect(after.sessions.develop).toBe(before.sessions.develop)
    expect(after.sessions.plan).toBe(before.sessions.plan)
    expect(after.sessions.review).not.toBe(before.sessions.review)
    expect(w.invocations().at(-1)).toMatchObject({ executor: 'claude', purpose: 'start' })
    expect(w.invocations().at(-1).config).toContain('--model=new-expert')
  })

  it('does not switch executors when retrying a rejected platform operation', async () => {
    world = await makeWorld({ settings: { executors: { codex: fakeExecutor('codex'), zcode: fakeExecutor('zcode') } } })
    const w = world
    w.fake.addTask('tsk_1')
    await untilState(w, KEY, 'needs_you', 'plan_confirm')
    await w.engine.command('confirmPlan', KEY, {})
    await untilState(w, KEY, 'needs_you', 'ready_to_test')
    w.fake.faults.push({ tool: 'task_submit_result', kind: 'reject', code: 'conflict', message: 'revision_mismatch' })
    await w.engine.command('submitTest', [KEY])
    const before = await untilState(w, KEY, 'needs_you', 'platform_rejected')
    const calls = w.fake.callsOf('task_submit_result').length
    await expect(w.engine.command('retry', KEY, 'zcode')).rejects.toMatchObject({ code: 'wrong_state' })
    expect(w.task(KEY)).toEqual(before)
    expect(w.fake.callsOf('task_submit_result')).toHaveLength(calls)
  })
})
