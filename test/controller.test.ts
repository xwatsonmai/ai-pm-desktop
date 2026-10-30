import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexEntries } from '../src/main/codex-log.js'
import { AppController, claimedClientForLogin, type Notice } from '../src/main/controller.js'
import type { Task } from '../src/core/types.js'
import { plainSecrets, Store } from '../src/core/store.js'
import { makeWorld, type World } from './helpers.js'

let world: World | null = null
let controller: AppController | null = null
afterEach(async () => {
  await controller?.stop()
  controller = null
  await world?.dispose()
  world = null
})

const host = { opened: [] as string[], copied: [] as string[], openExternal(url: string) { this.opened.push(url) }, openPath() {}, copy(text: string) { this.copied.push(text) }, launchAtLogin: () => false, setLaunchAtLogin() {} }

it('keeps an active claim owner for login, ignoring completed claims and refusing ambiguous owners', () => {
  const task = (client: string, status: Task['status'] = 'waiting') => ({
    kind: 'task', status, claimId: 'claim', data: { context: { task: { claim_client_id: client } } },
  }) as Task
  expect(claimedClientForLogin([task('original'), task('other', 'done')])).toBe('original')
  expect(claimedClientForLogin([task('original'), task('other')])).toBeUndefined()
  expect(claimedClientForLogin([{ ...task('unclaimed'), claimId: null }])).toBeUndefined()
})

async function setup(scenario?: Record<string, unknown[]>) {
  world = await makeWorld({ scenario })
  await world.engine.stop() // the controller runs its own engine on the same data
  controller = new AppController(world.dataDir, plainSecrets, host, join(world.root, 'legacy.json'), join(world.root, 'codex.toml'))
  await controller.start()
  return controller
}

const needs = (c: AppController, key: string, reason: string) =>
  untilAsync(async () => (await c.snapshot()).tasks.find((t) => t.key === key && t.status === 'needs_you' && t.reason === reason))

async function untilAsync<T>(read: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('timed out')
}

describe('AppController', () => {
  it('marks retained failed workspaces resolved after a successful re-test without deleting files or history', async () => {
    const c = await setup()
    world!.fake.addTask('tsk_1')
    await needs(c, 'task:tsk_1', 'plan_confirm')
    const store = new Store(join(world!.dataDir, 'db.sqlite'))
    try {
      const task = store.getTask('task:tsk_1')!
      const failed: Task = {
        ...structuredClone(task), key: 'batch:old-fail', platformId: 'old-fail', kind: 'batch',
        stage: 'test_release', status: 'closed', reason: null, worktree: null, branch: null,
        createdAt: '2026-10-29T01:00:00.000Z', data: { members: [task.key], release: { outcome: 'failed' } },
      }
      store.saveTask(failed)
      store.event(failed.key, 'run_failed', '旧提测冲突现场已保留')
      const oldDir = join(world!.dataDir, 'worktrees', 'b-old-fail')
      execFileSync('git', ['worktree', 'add', '--detach', oldDir, 'HEAD'], { cwd: world!.repoPath, stdio: 'ignore' })
      writeFileSync(join(oldDir, 'old-conflict.txt'), 'retained failed attempt')
      writeFileSync(join(task.worktree!, 'current-fix.txt'), 'unsaved current change')
      const before = (await c.detail('main', task.key))!
      expect(before.workspaces.find((w) => w.path === oldDir)).toMatchObject({ changes: ['old-conflict.txt'] })
      expect(before.workspaces.find((w) => w.path === oldDir)?.supersededBy).toBeUndefined()
      const later: Task = {
        ...failed, key: 'batch:success', platformId: 'success', status: 'done',
        createdAt: '2026-10-29T02:00:00.000Z', data: { members: [task.key], release: { outcome: 'success' } },
      }
      store.saveTask(later)
      const after = (await c.detail('main', task.key))!
      expect(after.workspaces.find((w) => w.path === oldDir)).toMatchObject({ changes: ['old-conflict.txt'], supersededBy: later.key })
      expect(after.workspaces.find((w) => w.path === task.worktree)).toMatchObject({ changes: ['current-fix.txt'] })
      expect(after.workspaces.find((w) => w.path === task.worktree)?.supersededBy).toBeUndefined()
      expect(after.events).toEqual(before.events)
      expect(after.runs).toEqual(before.runs)
      expect(existsSync(join(oldDir, 'old-conflict.txt'))).toBe(true)
      expect(store.getTask(failed.key)?.status).toBe('closed')
    } finally { store.close() }
  })

  it('rechecks executor health on save while retaining tasks, sessions and history', async () => {
    const c = await setup()
    world!.fake.addTask('tsk_1')
    await needs(c, 'task:tsk_1', 'plan_confirm')
    const before = (await c.detail('main', 'task:tsk_1'))!
    const { globals } = await c.getSettings()
    const codex = globals.executors.codex!
    expect(await c.saveGlobals({ ...globals, executors: { codex: { ...codex, binary: join(world!.root, 'missing-codex') } } })).toMatchObject({ ok: true })
    expect((await c.snapshot()).executors.find((e) => e.name === 'codex')?.healthy).toBe(false)
    expect(await c.saveGlobals(globals)).toMatchObject({ ok: true })
    expect((await c.snapshot()).executors.find((e) => e.name === 'codex')?.healthy).toBe(true)
    const after = (await c.detail('main', 'task:tsk_1'))!
    expect(after.task).toEqual({ ...before.task, updatedAt: after.task.updatedAt })
    expect(after.runs).toEqual(before.runs)
    expect(after.outbox).toEqual(before.outbox)
    expect(after.events).toEqual(before.events)
  })

  it('shows tasks, runs commands and reports command errors as results', async () => {
    const c = await setup()
    const notices: Notice[] = []
    c.on('notice', (n: Notice) => notices.push(n))
    world!.fake.addTask('tsk_1', '订单导出')
    const planned = await needs(c, 'task:tsk_1', 'plan_confirm')
    expect(planned.plan?.summary).toBe('方案摘要')
    expect(notices.some((n) => n.key === 'task:tsk_1' && n.title === '方案待确认')).toBe(true)

    const snapshot = await c.snapshot()
    expect(snapshot.configured).toBe(true)
    // The data directory from before projects becomes the first project, in place.
    expect(snapshot.projects).toEqual([expect.objectContaining({ id: 'main', projectId: 'prj_test', auth: { mode: 'static', loggedIn: true } })])
    expect(planned.project).toBe('main')
    expect(snapshot.executors.find((e) => e.name === 'codex')).toMatchObject({ configured: true, healthy: true })

    expect(await c.command('main', 'answer', ['task:tsk_1', 'x'])).toMatchObject({ ok: false, code: 'wrong_state' })
    expect(await c.command('main', 'dropDatabase' as any, [])).toMatchObject({ ok: false, code: 'unknown_command' })
    expect(await c.command('main', 'confirmPlan', ['task:tsk_1', {}])).toEqual({ ok: true, value: undefined })
    const ready = await needs(c, 'task:tsk_1', 'ready_to_test')
    expect(ready.dev?.sha).toMatch(/^[0-9a-f]{40}$/)
    // What is left uncommitted in the checkout shows on the task.
    writeFileSync(ready.worktree + '/scratch.txt', 'x\n')
    expect((await c.detail('main', 'task:tsk_1'))!.workspaces).toEqual([
      { label: '工作区', path: ready.worktree, exists: true, changes: ['scratch.txt'], removeAt: null },
    ])
    expect(ready.takeover?.command).toContain('codex resume ')
  })

  it('serves run logs incrementally and the diff of a task', async () => {
    const c = await setup()
    world!.fake.addTask('tsk_1')
    await needs(c, 'task:tsk_1', 'plan_confirm')
    await c.command('main', 'confirmPlan', ['task:tsk_1', {}])
    await needs(c, 'task:tsk_1', 'ready_to_test')
    const detail = (await c.detail('main', 'task:tsk_1'))!
    expect(detail.runs.map((r) => r.stage)).toEqual(['plan', 'develop'])
    expect(detail.events.length).toBeGreaterThan(0)
    expect(detail.outbox.some((o) => o.tool === 'task_claim' && o.status === 'done')).toBe(true)
    const first = await c.runLog('main', detail.runs[1].id, 0)
    expect(first.entries.map((e) => e.kind)).toEqual(['status', 'status', 'message', 'status'])
    expect(first.done).toBe(true)
    const again = await c.runLog('main', detail.runs[1].id, first.offset)
    expect(again.entries).toEqual([])
    const diff = (await c.diff('main', 'task:tsk_1'))!
    expect(diff.stat).toMatch(/work-\w+\.txt/)
    expect(diff.patch).toContain('+change')

    // The test release runs on a batch; the requirement's log includes it.
    await c.command('main', 'submitTest', [['task:tsk_1']])
    const released = await untilAsync(async () => {
      const d = (await c.detail('main', 'task:tsk_1'))!
      return d.task.platformStatus === 'testing' ? d : undefined
    })
    expect(released.runs.map((r) => r.stage)).toEqual(['plan', 'develop', 'test_release'])
    expect(released.events.some((e) => e.type === 'run_started' && e.message.startsWith('test_release'))).toBe(true)
  })

  it('validates settings and imports the old client config for review', async () => {
    const c = await setup()
    const { globals, projects: [{ id, settings: current }] } = await c.getSettings()
    expect(globals.executors.codex).toBeDefined()
    expect(current).not.toHaveProperty('executors')
    expect(await c.saveProject(id, { ...current, mcpUrl: 'not a url' })).toMatchObject({ ok: false, code: 'invalid_settings' })
    expect(await c.saveGlobals({ ...globals, executors: { codex: { ...globals.executors.codex!, limit: 9 } } })).toMatchObject({ ok: false })
    expect(await c.saveProject(id, { ...current, testReleaseInstructions: '新的说明' })).toEqual({ ok: true, value: 'main' })
    expect((await c.getSettings()).projects[0].settings.testReleaseInstructions).toBe('新的说明')

    expect(await c.importLegacy()).toBeNull()
    writeFileSync(join(world!.root, 'legacy.json'), JSON.stringify({
      project_id: 'prj_x', mcp_url: 'http://pm/mcp', resource_uri: 'ai-pm://projects/prj_x/work', protocol_version: '2026-07-28',
      repository: 'http://git/x.git', codex_project_path: '/tmp/x', codex_binary: '/bin/codex', start_ref: 'origin/main',
      release_instructions: '上线说明', test_release_instructions: '测试说明', claim_secret_should_not_matter: 'x',
      execution_config: { 'mcp_servers.ops.url': 'https://ops/mcp', 'features.x': true },
      execution_environment_instructions: '运营查询用 ops 连接',
      release_environments: [{ id: 'cn', name: '国内生产', address: 'https://cn', ssh: { host: 'cn-host' }, root: '/data/app' }],
    }))
    writeFileSync(join(world!.root, 'codex.toml'), 'model = "gpt-x"\nmodel_reasoning_effort = "high"\n\n[profiles.fast]\nmodel = "other"\n')
    const imported = await c.importLegacy()
    expect(imported).toMatchObject({
      project: { projectId: 'prj_x', mcpUrl: 'http://pm/mcp', repoPath: '/tmp/x', intakePaused: true, releaseInstructions: '上线说明' },
      globals: { executors: { codex: {
        binary: '/bin/codex', limit: 1, models: { expert: { model: 'gpt-x', effort: 'high' }, execution: { model: 'gpt-x', effort: 'high' } },
        configOverrides: ['mcp_servers.ops.url="https://ops/mcp"', 'features.x=true'],
      } } },
    })
    expect(imported!.project.environmentInstructions).toContain('运营查询用 ops 连接')
    expect(imported!.project.environmentInstructions).toContain('国内生产（cn）：https://cn，SSH 主机 cn-host，部署目录 /data/app')
    expect(JSON.stringify(imported)).not.toContain('claim_secret')
    expect(await c.saveGlobals({ ...globals, executors: { codex: { ...globals.executors.codex!, configOverrides: ['not an override'] } } }))
      .toMatchObject({ ok: false, code: 'invalid_settings' })
  })

  it('starts without settings and reports itself unconfigured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-pm-empty-'))
    controller = new AppController(dir, plainSecrets, host, join(dir, 'none.json'))
    await controller.start()
    const snapshot = await controller.snapshot()
    expect(snapshot.configured).toBe(false)
    expect(snapshot.projects).toEqual([])
    expect(await controller.command('main', 'retry', ['x'])).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('codexEntries', () => {
  it('merges a started command with its completion and formats the other events', () => {
    const entries = codexEntries([
      { type: 'thread.started', thread_id: 'th_1' },
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/a.js', kind: 'update' }] } },
      { type: 'turn.failed', error: { message: 'usage limit' } },
    ])
    expect(entries.map((e) => [e.kind, e.text])).toEqual([
      ['status', '会话 th_1'], ['command', 'npm test'], ['files', 'update src/a.js'], ['error', '本轮失败：usage limit'],
    ])
    expect(entries[1]).toMatchObject({ exitCode: 0, output: 'ok', running: false })
  })
})
