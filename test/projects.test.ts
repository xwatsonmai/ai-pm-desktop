import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppController } from '../src/main/controller.js'
import { plainSecrets } from '../src/core/store.js'
import type { Snapshot } from '../src/shared/api.js'
import { fakeExecutor, makeWorld, type World } from './helpers.js'

let controller: AppController | null = null
let worlds: World[] = []
afterEach(async () => {
  await controller?.stop()
  controller = null
  for (const world of worlds) await world.dispose()
  worlds = []
})

const host = { openExternal() {}, openPath() {}, copy() {}, launchAtLogin: () => false, setLaunchAtLogin() {} }

// Two projects, each with its own platform and repository, served by one client
// whose single Codex slot they share.
async function twoProjects(scenario?: Record<string, unknown[]>) {
  const a = await makeWorld()
  Object.assign(a.fake.project, { name: '订单系统' })
  // The fake agents read the last world's scenario, whichever project they work for.
  const b = await makeWorld({ settings: { projectId: 'prj_b' }, scenario })
  Object.assign(b.fake.project, { id: 'prj_b', name: '会员系统' })
  worlds = [a, b]
  for (const world of worlds) await world.engine.stop()
  const app = mkdtempSync(join(tmpdir(), 'ai-pm-app-'))
  writeFileSync(join(app, 'projects.json'), JSON.stringify({
    globals: { executors: { codex: fakeExecutor('codex', 1) }, allowedExecutors: ['codex'] },
    projects: [{ id: 'a', dataDir: a.dataDir }, { id: 'b', dataDir: b.dataDir }],
  }))
  controller = new AppController(app, plainSecrets, host)
  await controller.start()
  return { a, b, c: controller }
}

async function until(c: AppController, accept: (s: Snapshot) => boolean, timeoutMs = 20_000): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await c.snapshot()
    if (accept(snapshot)) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('timed out')
}

const at = (s: Snapshot, key: string) => s.tasks.find((t) => t.key === key)

describe('several projects', () => {
  it('keeps each project its own tasks and names, and acts on the right one', async () => {
    const { a, b, c } = await twoProjects()
    a.fake.addTask('tsk_a', '订单导出')
    b.fake.addTask('tsk_b', '会员等级')
    const planned = await until(c, (s) => at(s, 'task:tsk_a')?.reason === 'plan_confirm' && at(s, 'task:tsk_b')?.reason === 'plan_confirm')
    expect(planned.projects.map((p) => [p.id, p.projectId, p.name])).toEqual([['a', 'prj_test', '订单系统'], ['b', 'prj_b', '会员系统']])
    expect(at(planned, 'task:tsk_a')!.project).toBe('a')
    expect(at(planned, 'task:tsk_b')!.project).toBe('b')
    // Each platform only ever saw its own requirement.
    expect(a.fake.tasks.has('tsk_b')).toBe(false)
    expect(b.fake.tasks.get('tsk_b')!.status).toBe('doing')

    // A command goes to the project that holds the task.
    expect(await c.command('confirmPlan', ['task:tsk_b', {}])).toEqual({ ok: true, value: undefined })
    await until(c, (s) => at(s, 'task:tsk_b')?.reason === 'ready_to_test')
    expect(at(await c.snapshot(), 'task:tsk_a')!.reason).toBe('plan_confirm')
    expect((await c.detail('task:tsk_b'))!.task.project).toBe('b')

    // Intake pauses per project.
    await c.setIntakePaused('b', true)
    const paused = await c.snapshot()
    expect(paused.projects.map((p) => p.engine.intakePaused)).toEqual([false, true])
  })

  it('shares executor slots across projects', async () => {
    const { a, b, c } = await twoProjects({ plan: [{ type: 'hang', ms: 1_200 }, { type: 'hang', ms: 1_200 }] })
    a.fake.addTask('tsk_a')
    b.fake.addTask('tsk_b')
    let most = 0
    await until(c, (s) => {
      most = Math.max(most, s.tasks.filter((t) => t.running).length)
      return s.tasks.filter((t) => t.reason === 'plan_confirm').length === 2
    })
    // One Codex slot: the second project's plan waited for the first.
    expect(most).toBe(1)
  })

  it('adds and removes projects', async () => {
    const { b, c } = await twoProjects()
    const { projects: [first] } = await c.getSettings()
    // The same platform project cannot be added twice.
    expect(await c.saveProject(null, { ...first.settings })).toMatchObject({ ok: false, code: 'duplicate_project' })
    // A project with work in progress stays.
    b.fake.addTask('tsk_b')
    await until(c, (s) => at(s, 'task:tsk_b')?.reason === 'plan_confirm')
    expect(await c.removeProject('b')).toMatchObject({ ok: false, code: 'has_active_tasks' })
    expect(await c.removeProject('a')).toEqual({ ok: true, value: undefined })
    const left = await c.snapshot()
    expect(left.projects.map((p) => p.id)).toEqual(['b'])
    expect(left.tasks.every((t) => t.project === 'b')).toBe(true)
  })
})
