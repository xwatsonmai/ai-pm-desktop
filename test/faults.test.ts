import { afterEach, describe, expect, it } from 'vitest'
import { makeWorld, until, untilState, type World } from './helpers.js'

let world: World | null = null
afterEach(async () => {
  await world?.dispose()
  world = null
})

const KEY = 'task:tsk_1'

async function toReadyToTest(w: World) {
  w.fake.addTask('tsk_1')
  await untilState(w, KEY, 'needs_you', 'plan_confirm')
  await w.engine.command('confirmPlan', KEY, {})
  return untilState(w, KEY, 'needs_you', 'ready_to_test')
}

describe('agent failures recover without a person', () => {
  it('resumes the same session after the agent process crashes', async () => {
    world = await makeWorld({ scenario: { develop: [{ type: 'crash' }] } })
    await toReadyToTest(world)
    const develop = world.invocations().filter((c) => c.stage === 'develop')
    expect(develop.map((c) => c.purpose)).toEqual(['start', 'resume'])
    expect(develop[1].session).toBe(develop[0].session)
  })

  it('asks for help after three crashes in a row, and the retry button continues', async () => {
    world = await makeWorld({ scenario: { develop: [{ type: 'crash' }, { type: 'fail' }, { type: 'crash' }] } })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    await world.engine.command('confirmPlan', KEY, {})
    const stuck = await untilState(world, KEY, 'needs_you', 'executor_failing')
    expect(stuck.detail).toContain('连续 3 次')
    await world.engine.command('retry', KEY)
    await untilState(world, KEY, 'needs_you', 'ready_to_test')
  })

  it('sends a malformed result back to the same session for correction', async () => {
    world = await makeWorld({ scenario: { plan: [{ type: 'invalid' }] } })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    const plan = world.invocations().filter((c) => c.stage === 'plan')
    expect(plan.map((c) => c.purpose)).toEqual(['start', 'repair'])
    expect(plan[1].session).toBe(plan[0].session)
  })

  it('gives up on output after two corrections and shows the reason', async () => {
    world = await makeWorld({ scenario: { plan: [{ type: 'invalid' }, { type: 'invalid' }, { type: 'invalid' }] } })
    world.fake.addTask('tsk_1')
    const task = await untilState(world, KEY, 'needs_you', 'output_invalid')
    expect(task.detail).toContain('不是 JSON')
  })

  it('makes the agent commit leftover changes before accepting a development result', async () => {
    world = await makeWorld({ scenario: { develop: [{ type: 'dirty' }] } })
    await toReadyToTest(world)
    expect(world.invocations().filter((c) => c.stage === 'develop').map((c) => c.purpose)).toEqual(['start', 'repair'])
  })

  it('picks up a run that kept going while the client restarted', async () => {
    world = await makeWorld({ scenario: { develop: [{ type: 'hang', ms: 1_500 }] } })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    await world.engine.command('confirmPlan', KEY, {})
    await untilState(world, KEY, 'running')
    await world.restart()
    await untilState(world, KEY, 'needs_you', 'ready_to_test')
    expect(world.invocations().filter((c) => c.stage === 'develop')).toHaveLength(1)
  })
})

describe('platform failures recover without a person', () => {
  it('resends a write whose response was lost, and the platform applies it once', async () => {
    world = await makeWorld()
    await toReadyToTest(world)
    world.fake.faults.push({ tool: 'task_submit_result', kind: 'drop_response' })
    await world.engine.command('submitTest', [KEY])
    await untilState(world, KEY, 'waiting', 'testing')
    const calls = world.fake.callsOf('task_submit_result')
    expect(calls.map((c) => c.outcome)).toEqual(['dropped', 'ok'])
    expect(calls[0].args.request_id).toBe(calls[1].args.request_id)
  })

  it('retries reading the work list after a server error', async () => {
    world = await makeWorld()
    world.fake.faults.push({ tool: 'work_list', kind: 'http500' }, { tool: 'work_list', kind: 'http500' })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
  })

  it('finds new work through the polling fallback when notifications are lost', async () => {
    world = await makeWorld()
    await until(() => world!.engine.status.connected, Boolean, 'subscribed')
    world.fake.notifyEnabled = false
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
  })

  it('reconnects the subscription after it drops', async () => {
    world = await makeWorld({ settings: { timing: { tickMs: 40, pollActiveMs: 60_000, pollIdleMs: 60_000, backoffMs: [40], reconnectMs: [40], collabReportMs: 200, callTimeoutMs: 5_000, bindingCheckMs: 0, probeMs: 60_000 } } })
    await until(() => world!.engine.status.connected, Boolean, 'subscribed')
    world.fake.dropListeners()
    await until(() => world!.engine.status.connected, (v) => !v, 'disconnected')
    await until(() => world!.engine.status.connected, Boolean, 'reconnected')
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
  })

  it('shows a business rejection with its reason and retries with fresh values', async () => {
    world = await makeWorld()
    await toReadyToTest(world)
    world.fake.faults.push({ tool: 'task_submit_result', kind: 'reject', code: 'conflict', message: 'revision_mismatch' })
    await world.engine.command('submitTest', [KEY])
    const rejected = await untilState(world, KEY, 'needs_you', 'platform_rejected')
    expect(rejected.detail).toContain('revision_mismatch')
    await world.engine.command('retry', KEY)
    await untilState(world, KEY, 'waiting', 'testing')
  })

  it('keeps other tasks moving while one task cannot be read', async () => {
    world = await makeWorld({ limit: 2 })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    world.fake.brokenContext.add('tsk_1')
    world.fake.addTask('tsk_2')
    await untilState(world, 'task:tsk_2', 'needs_you', 'plan_confirm')
    expect(world.task(KEY).lastError).toBeTruthy()
  })
})

describe('release problems', () => {
  it('lets the user continue a failed test release in the same session', async () => {
    world = await makeWorld({
      scenario: {
        test_release: [{
          type: 'result',
          value: { outcome: 'failed', deployed_sha: '', environment: 'test', summary: '构建失败：缺少依赖', verification: '', limitations: '未部署', items: [] },
        }],
      },
    })
    await toReadyToTest(world)
    await world.engine.command('submitTest', [KEY])
    const batch = await until(() => world!.engine.store.listTasks({ kind: ['batch'] })[0], (b) => b?.status === 'needs_you', 'batch needs you')
    expect(batch.reason).toBe('release_failed')
    expect(batch.detail).toContain('构建失败')
    expect(world.task(KEY)).toMatchObject({ status: 'waiting', reason: 'in_batch' })
    await world.engine.command('continueRelease', batch.key)
    await untilState(world, KEY, 'waiting', 'testing')
    const releases = world.invocations().filter((c) => c.stage === 'test_release')
    expect(releases.map((c) => c.purpose)).toEqual(['start', 'continue'])
    expect(releases[1].session).toBe(releases[0].session)
  })

  it('accepts a manual confirmation that a release is done', async () => {
    world = await makeWorld({
      scenario: {
        test_release: [{
          type: 'result',
          value: { outcome: 'partial', deployed_sha: 'abc', environment: 'test', summary: '健康检查超时', verification: '', limitations: '', items: [] },
        }],
      },
    })
    await toReadyToTest(world)
    await world.engine.command('submitTest', [KEY])
    const batch = await until(() => world!.engine.store.listTasks({ kind: ['batch'] })[0], (b) => b?.status === 'needs_you', 'batch needs you')
    await world.engine.command('markReleased', batch.key, '我手动看过，测试环境正常')
    await untilState(world, KEY, 'waiting', 'testing')
  })
})
