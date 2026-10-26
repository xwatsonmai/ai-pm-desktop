import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexEntries } from '../src/main/codex-log.js'
import { AppController, type Notice } from '../src/main/controller.js'
import { plainSecrets } from '../src/core/store.js'
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
    expect(snapshot.auth).toEqual({ mode: 'static', loggedIn: true })
    expect(snapshot.executors.find((e) => e.name === 'codex')).toMatchObject({ configured: true, healthy: true })

    expect(await c.command('answer', ['task:tsk_1', 'x'])).toMatchObject({ ok: false, code: 'wrong_state' })
    expect(await c.command('dropDatabase' as any, [])).toMatchObject({ ok: false, code: 'unknown_command' })
    expect(await c.command('confirmPlan', ['task:tsk_1', {}])).toEqual({ ok: true, value: undefined })
    const ready = await needs(c, 'task:tsk_1', 'ready_to_test')
    expect(ready.dev?.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(ready.takeover?.command).toContain('codex resume ')
  })

  it('serves run logs incrementally and the diff of a task', async () => {
    const c = await setup()
    world!.fake.addTask('tsk_1')
    await needs(c, 'task:tsk_1', 'plan_confirm')
    await c.command('confirmPlan', ['task:tsk_1', {}])
    await needs(c, 'task:tsk_1', 'ready_to_test')
    const detail = (await c.detail('task:tsk_1'))!
    expect(detail.runs.map((r) => r.stage)).toEqual(['plan', 'develop'])
    expect(detail.events.length).toBeGreaterThan(0)
    expect(detail.outbox.some((o) => o.tool === 'task_claim' && o.status === 'done')).toBe(true)
    const first = await c.runLog(detail.runs[1].id, 0)
    expect(first.entries.map((e) => e.kind)).toEqual(['status', 'status', 'message', 'status'])
    expect(first.done).toBe(true)
    const again = await c.runLog(detail.runs[1].id, first.offset)
    expect(again.entries).toEqual([])
    const diff = (await c.diff('task:tsk_1'))!
    expect(diff.stat).toMatch(/work-\w+\.txt/)
    expect(diff.patch).toContain('+change')

    // The test release runs on a batch; the requirement's log includes it.
    await c.command('submitTest', [['task:tsk_1']])
    const released = await untilAsync(async () => {
      const d = (await c.detail('task:tsk_1'))!
      return d.task.platformStatus === 'testing' ? d : undefined
    })
    expect(released.runs.map((r) => r.stage)).toEqual(['plan', 'develop', 'test_release'])
    expect(released.events.some((e) => e.type === 'run_started' && e.message.startsWith('test_release'))).toBe(true)
  })

  it('validates settings and imports the old client config for review', async () => {
    const c = await setup()
    const current = (await c.getSettings())!
    expect(await c.saveSettings({ ...current, mcpUrl: 'not a url' })).toMatchObject({ ok: false, code: 'invalid_settings' })
    expect(await c.saveSettings({ ...current, executors: { codex: { ...current.executors.codex!, limit: 9 } } })).toMatchObject({ ok: false })
    expect(await c.saveSettings({ ...current, testReleaseInstructions: '新的说明' })).toEqual({ ok: true, value: undefined })
    expect((await c.getSettings())!.testReleaseInstructions).toBe('新的说明')

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
      projectId: 'prj_x', mcpUrl: 'http://pm/mcp', repoPath: '/tmp/x', intakePaused: true, releaseInstructions: '上线说明',
      executors: { codex: {
        binary: '/bin/codex', limit: 1, models: { expert: { model: 'gpt-x', effort: 'high' }, execution: { model: 'gpt-x', effort: 'high' } },
        configOverrides: ['mcp_servers.ops.url="https://ops/mcp"', 'features.x=true'],
      } },
    })
    expect(imported!.environmentInstructions).toContain('运营查询用 ops 连接')
    expect(imported!.environmentInstructions).toContain('国内生产（cn）：https://cn，SSH 主机 cn-host，部署目录 /data/app')
    expect(JSON.stringify(imported)).not.toContain('claim_secret')
    expect(await c.saveSettings({ ...current, executors: { codex: { ...current.executors.codex!, configOverrides: ['not an override'] } } }))
      .toMatchObject({ ok: false, code: 'invalid_settings' })
  })

  it('starts without settings and reports itself unconfigured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-pm-empty-'))
    controller = new AppController(dir, plainSecrets, host, join(dir, 'none.json'))
    await controller.start()
    const snapshot = await controller.snapshot()
    expect(snapshot.configured).toBe(false)
    expect(snapshot.engine.running).toBe(false)
    expect(await controller.command('retry', ['x'])).toMatchObject({ ok: false, code: 'not_running' })
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
