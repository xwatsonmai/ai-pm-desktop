import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeWorld, until, untilState, type World } from './helpers.js'

let world: World | null = null
afterEach(async () => {
  await world?.dispose()
  world = null
})

const KEY = 'task:tsk_1'

describe('end to end on the fake platform', () => {
  it('claims, plans, develops, test-releases and releases a requirement with three user clicks', async () => {
    world = await makeWorld()
    const { fake } = world
    fake.addTask('tsk_1', '订单列表加筛选')

    const planned = await untilState(world, KEY, 'needs_you', 'plan_confirm')
    expect(fake.tasks.get('tsk_1')!.status).toBe('doing')
    expect(planned.claimId).toBe(fake.tasks.get('tsk_1')!.claim_id)
    expect(planned.data.plan).toMatchObject({ summary: '方案摘要' })

    await world.engine.command('confirmPlan', KEY, {})
    const developed = await untilState(world, KEY, 'needs_you', 'ready_to_test')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: developed.worktree!, encoding: 'utf8' }).trim()
    expect(developed.data.dev!.sha).toBe(head)
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: developed.worktree!, encoding: 'utf8' }).trim()).toBe('ai-pm/tsk_1')

    await world.engine.command('submitTest', [KEY])
    await untilState(world, KEY, 'waiting', 'testing')
    expect(fake.tasks.get('tsk_1')!.submission).toMatchObject({ sha: head })

    fake.passTest('tsk_1')
    await untilState(world, KEY, 'needs_you', 'ready_to_release')

    await world.engine.command('release', [KEY])
    await untilState(world, KEY, 'waiting', 'acceptance')
    expect(fake.tasks.get('tsk_1')!.status).toBe('review')

    fake.accept('tsk_1')
    await untilState(world, KEY, 'done')

    const calls = world.invocations()
    expect(calls.map((c) => c.stage)).toEqual(['plan', 'develop', 'test_release', 'release'])
    expect(calls[0].readOnly).toBe(true)
    expect(calls[1].readOnly).toBe(false)
    // Agents get the requirement, not the whole project's lists.
    const context = JSON.parse(execFileSync('cat', [developed.worktree + '/.ai-pm/task.json'], { encoding: 'utf8' }))
    expect(context.artifacts).toBeUndefined()
    expect(context.tasks).toBeUndefined()
    expect(context.task.id).toBe('tsk_1')
    // The context directory is never committed.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: developed.worktree!, encoding: 'utf8' })).toBe('')
  })

  it('sends rework, release and close in the shape the platform accepts', async () => {
    world = await makeWorld({ limit: 3 })
    const { fake } = world
    for (const id of ['tsk_1', 'tsk_2', 'tsk_3']) fake.addTask(id)
    for (const id of ['tsk_1', 'tsk_2', 'tsk_3']) await untilState(world, 'task:' + id, 'needs_you', 'plan_confirm')

    await world.engine.command('confirmPlan', KEY, {})
    await untilState(world, KEY, 'needs_you', 'ready_to_test')
    await world.engine.command('submitTest', [KEY])
    await untilState(world, KEY, 'waiting', 'testing')
    fake.passTest('tsk_1')
    await untilState(world, KEY, 'needs_you', 'ready_to_release')
    await world.engine.command('rework', KEY, '上线前发现样式问题')
    await until(() => fake.tasks.get('tsk_1')!.status, (s) => s === 'doing', 'reworked on the platform')

    await world.engine.command('releaseClaim', 'task:tsk_2', '方案已出，交给别人开发')
    await untilState(world, 'task:tsk_2', 'closed')
    expect(fake.tasks.get('tsk_2')!.status).toBe('ready')

    // The platform version moved since the client last read it; closing reads it again.
    fake.update('tsk_3', () => {})
    await world.engine.command('closeRequirement', 'task:tsk_3', '不做了', false)
    await untilState(world, 'task:tsk_3', 'closed')
    expect(fake.tasks.get('tsk_3')!.status).toBe('closed')

    const rejected = fake.calls.filter((c) => c.outcome === 'rejected')
    expect(rejected).toEqual([])
    // A task the user handed back stays in the pool for someone else.
    expect(fake.callsOf('task_claim').filter((c) => c.args.task_id === 'tsk_2')).toHaveLength(1)
    expect(fake.tasks.get('tsk_2')!.claimant).toBeNull()
  })

  it('runs agents in the project subdirectory of each checkout when the project is not the repository root', async () => {
    world = await makeWorld({ subdir: 'server' })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    await world.engine.command('confirmPlan', KEY, {})
    const developed = await untilState(world, KEY, 'needs_you', 'ready_to_test')
    const root = developed.worktree!
    expect(existsSync(join(root, 'server', '.ai-pm', 'task.json'))).toBe(true)
    expect(existsSync(join(root, '.ai-pm'))).toBe(false)
    const changed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    expect(changed).toMatch(/^server\/work-/)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('')

    await world.engine.command('submitTest', [KEY])
    await untilState(world, KEY, 'waiting', 'testing')
    const calls = world.invocations()
    expect(calls.map((c) => c.stage)).toEqual(['plan', 'develop', 'test_release'])
    expect(calls[0].cwd).toBe(join(root, 'server'))
    expect(calls[1].cwd).toBe(join(root, 'server'))
    expect(calls[2].cwd.endsWith('/server')).toBe(true)
    expect(calls[2].cwd.startsWith(root)).toBe(false) // the release has its own checkout
  })

  it('runs a read-only collaboration and renews its lease while running', async () => {
    world = await makeWorld({ scenario: { collab: [{ type: 'hang', ms: 700 }] } })
    world.fake.addCollaboration('collab_1')
    await untilState(world, 'collaboration:collab_1', 'done')
    expect(world.fake.collaborations.get('collab_1')!.status).toBe('completed')
    expect(world.fake.callsOf('collaboration_report').length).toBeGreaterThan(0)
    expect(world.invocations()[0].readOnly).toBe(true)
  })

  it('asks the agent to fill a collaboration field the platform would refuse empty', async () => {
    const empty = { outcome: 'inconclusive', summary: '没查到', environment: 'production', observed_at: '2026-10-24 10:00 +08:00', deployment_version: 'v1', limitations: '', evidence: '' }
    world = await makeWorld({ scenario: { collab: [{ type: 'result', value: empty }] } })
    world.fake.addCollaboration('collab_1')
    await untilState(world, 'collaboration:collab_1', 'done')
    expect(world.invocations().map((c) => c.purpose)).toEqual(['start', 'repair'])
    expect(world.fake.callsOf('collaboration_submit_result').map((c) => c.outcome)).toEqual(['ok'])
  })

  it('goes through product alignment and continues in the same development session', async () => {
    world = await makeWorld({ scenario: { develop: [{ type: 'needs_alignment' }] } })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    await world.engine.command('confirmPlan', KEY, {})
    await untilState(world, KEY, 'waiting', 'aligning')
    expect(world.fake.tasks.get('tsk_1')!.status).toBe('aligning')

    world.fake.replyAlignment('tsk_1', '计入退款月')
    await untilState(world, KEY, 'needs_you', 'ready_to_test')
    expect(world.fake.tasks.get('tsk_1')!.status).toBe('doing')
    const develop = world.invocations().filter((c) => c.stage === 'develop')
    expect(develop.map((c) => c.purpose)).toEqual(['start', 'alignment', 'continue'])
    expect(new Set(develop.map((c) => c.session)).size).toBe(1)
    // The renewed claim is used afterwards.
    expect(world.task(KEY).claimId).toBe(world.fake.tasks.get('tsk_1')!.claim_id)
  })

  it('stops the agent and closes the task when the platform cancels it', async () => {
    world = await makeWorld({ scenario: { plan: [{ type: 'hang', ms: 60_000 }] } })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'running')
    const run = await until(() => world!.engine.store.openRuns()[0], Boolean, 'open run')
    world.fake.cancel('tsk_1')
    await untilState(world, KEY, 'closed')
    await until(() => {
      try {
        process.kill(run.pid, 0)
        return false
      } catch {
        return true
      }
    }, Boolean, 'agent process gone')
  })

  it('sends a changed requirement back to planning', async () => {
    world = await makeWorld()
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    world.fake.changeRequirement('tsk_1')
    await until(() => world!.invocations().filter((c) => c.stage === 'plan').length, (n) => n === 2, 'second plan run')
    const task = await untilState(world, KEY, 'needs_you', 'plan_confirm')
    expect(task.revision).toBe(2)
    expect(world.invocations()[1].purpose).toBe('continue')
  })
})
