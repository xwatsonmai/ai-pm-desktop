import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppController } from '../src/main/controller.js'
import { plainSecrets } from '../src/core/store.js'
import type { Snapshot } from '../src/shared/api.js'
import { fakeExecutor, makeWorld, untilState, type World } from './helpers.js'

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
  return { a, b, c: controller, app }
}

async function until(c: AppController, accept: (s: Snapshot) => boolean, timeoutMs = 20_000): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const first = await c.snapshot()
    const parts = await Promise.all(first.projects.map((p) => c.snapshot(p.id)))
    const snapshot = { ...first, tasks: parts.flatMap((p) => p.tasks) }
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
    expect(await c.command('b', 'confirmPlan', ['task:tsk_b', {}])).toEqual({ ok: true, value: undefined })
    await until(c, (s) => at(s, 'task:tsk_b')?.reason === 'ready_to_test')
    expect(at(await c.snapshot(), 'task:tsk_a')!.reason).toBe('plan_confirm')
    expect((await c.detail('b', 'task:tsk_b'))!.task.project).toBe('b')

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


describe('workspace boundaries', () => {
  it('scopes snapshots, details, logs, diffs and batch commands to an explicit project, including colliding task IDs', async () => {
    const { a, b, c } = await twoProjects()
    a.fake.addTask('same', '订单系统里的同号任务')
    b.fake.addTask('same', '会员系统里的同号任务')
    b.fake.addTask('only_b', '仅会员系统可见')
    await until(c, (s) => s.tasks.filter((t) => t.reason === 'plan_confirm').length === 3)
    const sa = await c.snapshot('a'), sb = await c.snapshot('b')
    expect(sa.tasks.map((t) => t.title)).toEqual(['订单系统里的同号任务'])
    expect(sb.tasks.every((t) => t.project === 'b')).toBe(true)
    expect(sa.projects.find((p) => p.id === 'b')!.counts.needs).toBe(2)
    expect((await c.detail('a', 'task:same'))!.task.title).toBe('订单系统里的同号任务')
    expect((await c.detail('b', 'task:same'))!.task.title).toBe('会员系统里的同号任务')
    expect(await c.detail('a', 'task:only_b')).toBeNull()
    expect(await c.diff('a', 'task:only_b')).toBeNull()
    const bRun = (await c.detail('b', 'task:only_b'))!.runs[0]
    expect((await c.runLog('b', bRun.id, 0)).entries.length).toBeGreaterThan(0)
    expect((await c.runLog('a', bRun.id, 0)).entries).toEqual([])
    expect(await c.command('a', 'confirmPlan', ['task:only_b', {}])).toMatchObject({ ok: false, code: 'not_found' })
    expect(await c.command('a', 'submitTest', [['task:same', 'task:only_b']])).toMatchObject({ ok: false, code: 'not_found' })
    expect(await c.command('b', 'confirmPlan', ['task:same', {}])).toMatchObject({ ok: true })
    await until(c, (s) => s.tasks.some((t) => t.project === 'b' && t.reason === 'ready_to_test'))
    expect((await c.detail('a', 'task:same'))!.task.reason).toBe('plan_confirm')
  })

  it('migrates the old effective global policy once, then keeps each project choice through client edits and restart', async () => {
    const { a, b, c, app } = await twoProjects()
    const first = await c.getSettings()
    expect(first.projects.map((p) => p.settings.allowedExecutors)).toEqual([['codex'], ['codex']])
    expect(first.globals).not.toHaveProperty('allowedExecutors')
    expect(readFileSync(join(app, 'projects.json.before-workspaces'), 'utf8')).toContain('allowedExecutors')
    expect(await c.saveGlobals({ ...first.globals, executors: { ...first.globals.executors, zcode: fakeExecutor('zcode') } })).toMatchObject({ ok: true })
    expect(await c.saveProject('a', { ...first.projects[0].settings, allowedExecutors: ['codex'] })).toMatchObject({ ok: true })
    expect(await c.saveProject('b', { ...first.projects[1].settings, allowedExecutors: ['codex', 'zcode'] })).toMatchObject({ ok: true })
    const edited = await c.getSettings()
    expect(await c.saveGlobals({ ...edited.globals, worktreeRetentionDays: 30 })).toMatchObject({ ok: true })
    await c.selectProject('b')
    await c.stop()
    controller = new AppController(app, plainSecrets, host)
    await controller.start()
    expect((await controller.snapshot()).projectId).toBe('b')
    expect((await controller.getSettings()).projects.map((p) => p.settings.allowedExecutors)).toEqual([['codex'], ['codex', 'zcode']])
    a.fake.addTask('task_a'); b.fake.addTask('task_b')
    await until(controller, (s) => s.tasks.filter((t) => t.reason === 'plan_confirm').length === 2)
    expect(JSON.parse(readFileSync(join(app, 'projects.json'), 'utf8')).globals.allowedExecutors).toBeUndefined()
  })

  it('migrates an existing workspace without replacing its active run, worktree or platform claim', async () => {
    const w = await makeWorld({ scenario: { plan: [{ type: 'hang', ms: 2_200 }] } })
    worlds = [w]
    w.fake.addTask('existing')
    const task = await untilState(w, 'task:existing', 'running')
    const original = w.engine.store.openRuns()[0]
    await w.engine.stop()
    const app = mkdtempSync(join(tmpdir(), 'ai-pm-upgrade-'))
    writeFileSync(join(app, 'projects.json'), JSON.stringify({ globals: { executors: w.settings.executors, allowedExecutors: ['codex'] }, projects: [{ id: 'a', dataDir: w.dataDir }] }))
    controller = new AppController(app, plainSecrets, host)
    await controller.start()
    const detail = (await controller.detail('a', task.key))!
    expect(detail.task).toMatchObject({ worktree: task.worktree, branch: task.branch })
    expect(detail.runs.map((r) => r.id)).toEqual([original.id])
    await until(controller, (s) => s.tasks[0]?.reason === 'plan_confirm')
    expect(w.fake.callsOf('task_claim')).toHaveLength(1)
    expect(w.invocations()).toHaveLength(1)
    expect((await controller.detail('a', task.key))!.runs[0]).toMatchObject({ id: original.id, outcome: 'completed' })
  })

  it('dispatches only to project-enabled executors and allows an empty project policy', async () => {
    const { a, b, c } = await twoProjects()
    const settings = await c.getSettings()
    await c.saveGlobals({ ...settings.globals, executors: { ...settings.globals.executors, zcode: fakeExecutor('zcode') } })
    await c.saveProject('a', { ...settings.projects[0].settings, allowedExecutors: [] })
    await c.saveProject('b', { ...settings.projects[1].settings, allowedExecutors: ['zcode'] })
    a.fake.addTask('not_claimed'); b.fake.addTask('zcode_only')
    await until(c, (s) => s.tasks.some((t) => t.platformId === 'zcode_only' && t.reason === 'plan_confirm'))
    expect((await c.snapshot('a')).tasks).toEqual([])
    expect(a.fake.callsOf('task_claim')).toHaveLength(0)
    expect((await c.snapshot('b')).tasks[0].executor).toBe('zcode')
    expect(await c.command('b', 'confirmPlan', ['task:zcode_only', {}])).toMatchObject({ ok: true })
    await until(c, (s) => s.tasks.some((t) => t.reason === 'ready_to_test'))
    expect(await c.command('b', 'startReview', ['task:zcode_only', 'codex'])).toMatchObject({ ok: false, code: 'executor_disabled' })
  })

  it('keeps a running round alive when its executor is disabled and asks for an explicit choice before starting the next round', async () => {
    const { a, c } = await twoProjects({ plan: [{ type: 'hang', ms: 1_800 }] })
    a.fake.addTask('running')
    const started = await until(c, (s) => s.tasks.some((t) => t.running))
    const task = started.tasks[0]
    const originalRun = (await c.detail('a', task.key))!.runs[0]
    const { projects } = await c.getSettings()
    await c.saveProject('a', { ...projects[0].settings, allowedExecutors: [] })
    expect((await c.detail('a', task.key))!.runs[0].id).toBe(originalRun.id)
    await until(c, (s) => s.tasks.some((t) => t.reason === 'plan_confirm'))
    await c.command('a', 'confirmPlan', [task.key, {}])
    await until(c, (s) => s.tasks.some((t) => t.reason === 'executor_disabled'))
    expect((await c.detail('a', task.key))!.runs).toHaveLength(1)
    expect(await c.command('a', 'retry', [task.key, 'codex'])).toMatchObject({ ok: false, code: 'executor_disabled' })
    await c.saveProject('a', { ...projects[0].settings, allowedExecutors: ['codex'] })
    expect(await c.command('a', 'retry', [task.key, 'codex'])).toMatchObject({ ok: true })
    await until(c, (s) => s.tasks.some((t) => t.reason === 'ready_to_test'))
    expect(a.fake.callsOf('task_claim')).toHaveLength(1)
  })
})
