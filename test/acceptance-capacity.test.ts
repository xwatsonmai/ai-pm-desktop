import { afterEach, describe, expect, it } from 'vitest'
import { occupiesTaskCapacity } from '../src/shared/task-status.js'
import { makeWorld, until, untilState, type World } from './helpers.js'

let world: World | null = null
afterEach(async () => { await world?.dispose(); world = null })

const KEY = 'task:tsk_1'

async function releaseFirst(w: World) {
  w.fake.addTask('tsk_1')
  await untilState(w, KEY, 'needs_you', 'plan_confirm')
  await w.engine.command('confirmPlan', KEY, {})
  await untilState(w, KEY, 'needs_you', 'ready_to_test')
  await w.engine.command('submitTest', [KEY])
  await untilState(w, KEY, 'waiting', 'testing')
  w.fake.passTest('tsk_1')
  await untilState(w, KEY, 'needs_you', 'ready_to_release')
  await w.engine.command('release', [KEY])
  await untilState(w, KEY, 'waiting', 'acceptance')
}

describe('acceptance does not hold project intake capacity', () => {
  it('claims new work at a one-task limit, including after restart, and still receives acceptance', async () => {
    world = await makeWorld({ settings: { maxOpenTasks: 1 } })
    await releaseFirst(world)
    await world.restart()
    world.fake.addTask('tsk_2')
    await untilState(world, 'task:tsk_2', 'needs_you', 'plan_confirm')
    expect(world.task(KEY)).toMatchObject({ status: 'waiting', reason: 'acceptance' })
    expect(world.engine.store.listTasks().filter(occupiesTaskCapacity)).toHaveLength(1)
    world.fake.accept('tsk_1')
    await untilState(world, KEY, 'done')
    expect(world.fake.callsOf('task_claim').filter((c) => c.args.task_id === 'tsk_1')).toHaveLength(1)
  })

  it('counts returned work again, blocks further intake, and respects the executor limit', async () => {
    world = await makeWorld({ settings: { maxOpenTasks: 1 }, scenario: { develop: [{}, { type: 'hang' }] } })
    await releaseFirst(world)
    world.fake.addTask('tsk_2')
    await untilState(world, 'task:tsk_2', 'needs_you', 'plan_confirm')
    world.fake.returnToDev('tsk_1')
    await untilState(world, KEY, 'running')
    expect(world.task(KEY).stage).toBe('develop')
    expect(occupiesTaskCapacity(world.task(KEY))).toBe(true)
    await world.engine.command('confirmPlan', 'task:tsk_2', {})
    world.fake.addTask('tsk_3')
    const reads = world.fake.callsOf('work_list').length
    await until(() => world!.fake.callsOf('work_list').length, (n) => n >= reads + 2, 'two intake checks')
    expect(world.engine.store.getTask('task:tsk_3')).toBeNull()
    expect(world.task('task:tsk_2').status).toBe('queued')
    expect(world.engine.store.openRuns()).toHaveLength(1)
    expect(world.engine.store.listTasks().filter(occupiesTaskCapacity)).toHaveLength(2)
  })
})
