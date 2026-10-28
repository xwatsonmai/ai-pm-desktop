import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppController } from '../src/main/controller.js'
import { platformMcpUrl } from '../src/core/platform/binding.js'
import { OAuthTokenProvider } from '../src/core/platform/oauth.js'
import { plainSecrets, Store } from '../src/core/store.js'
import type { ProjectSettings } from '../src/core/types.js'
import type { ProjectBinding } from '../src/shared/api.js'
import { FakePlatform } from './fake-platform.js'
import { makeWorld, untilState, type World } from './helpers.js'

let world: World | undefined
let controller: AppController | undefined
let fake: FakePlatform | undefined
let appDir: string | undefined
const browserErrors: unknown[] = []
const host = { openExternal(url: string) { void (async () => {
  const res = await fetch(url, { redirect: 'manual' })
  const callback = res.headers.get('location')
  if (!callback) throw new Error('authorization did not redirect')
  await fetch(callback)
})().catch((error) => browserErrors.push(error)) }, openPath() {}, copy() {}, launchAtLogin: () => false, setLaunchAtLogin() {} }

afterEach(async () => {
  await controller?.stop(); controller = undefined
  await fake?.stop(); fake = undefined
  await world?.dispose(); world = undefined
  if (appDir) rmSync(appDir, { recursive: true, force: true }); appDir = undefined
  expect(browserErrors.splice(0)).toEqual([])
})

async function setup() {
  world = await makeWorld({ subdir: 'server', settings: { intakePaused: true } })
  fake = new FakePlatform(world.origin, '/syai/zhiqu')
  await fake.start()
  appDir = mkdtempSync(join(tmpdir(), 'ai-pm-binding-'))
  controller = new AppController(appDir, plainSecrets, host)
  await controller.saveGlobals({ executors: world.settings.executors, allowedExecutors: ['codex'] })
  return controller
}

function settings(binding: ProjectBinding): ProjectSettings {
  return { ...world!.settings, ...binding, intakePaused: true }
}

describe('project binding from platform authorization', () => {
  it('normalizes root, mounted platform and explicit MCP entries without dropping the mount', () => {
    for (const entry of ['https://example.com/syai/zhiqu', 'https://example.com/syai/zhiqu/', 'https://example.com/syai/zhiqu/mcp/']) expect(platformMcpUrl(entry)).toBe('https://example.com/syai/zhiqu/mcp')
    expect(platformMcpUrl('https://example.com')).toBe('https://example.com/mcp')
    for (const url of ['file:///tmp/x', 'https://user:secret@example.com', 'https://example.com/?token=x']) expect(() => platformMcpUrl(url)).toThrow()
  })

  it('logs in before any project settings, discovers paginated resources, validates a subdirectory and transfers authorization once', async () => {
    const c = await setup()
    fake!.resourcePages = [{ resources: [{ uri: 'ai-pm://other', name: 'other' }], nextCursor: '1' }, { resources: [{ uri: fake!.resourceUri, name: 'work' }] }]
    fake!.addTask('tsk_ready')
    const discovered = await c.discoverProject(fake!.url.replace(/\/mcp$/, '/'))
    expect(discovered.ok).toBe(true)
    if (!discovered.ok) throw new Error(discovered.message)
    const binding = discovered.value
    expect(binding).toMatchObject({ projectId: 'prj_test', mcpUrl: fake!.url, resourceUri: fake!.resourceUri, repository: world!.origin, startRef: 'origin/main' })
    expect(JSON.stringify(binding)).not.toMatch(/access_token|refresh_token|verifier/)
    expect((await c.snapshot()).projects).toEqual([])
    expect(fake!.callsOf('task_claim')).toHaveLength(0)
    expect(await c.checkRepository(settings(binding))).toMatchObject({ ok: true, value: { branch: 'origin/main' } })
    expect(await c.saveProject(null, { ...settings(binding), projectId: 'prj_wrong' }, binding.ticket)).toMatchObject({ ok: false, code: 'binding_mismatch' })
    const saved = await c.saveProject(null, settings(binding), binding.ticket)
    expect(saved).toEqual({ ok: true, value: 'main' })
    expect((await c.snapshot()).projects[0]).toMatchObject({ id: 'main', auth: { loggedIn: true }, engine: { intakePaused: true } })
    const own = (await c.getSettings()).projects[0].settings
    expect(own.oauthRedirectPort).toBeGreaterThan(0)
    expect(own.startRef).toBe('origin/main')
    const db = new Store(join(appDir!, 'db.sqlite'))
    const auth = JSON.parse(db.getSecret('oauth')!)
    await new OAuthTokenProvider(db, fake!.url).refresh()
    expect(JSON.parse(db.getSecret('oauth')!).client.client_id).toBe(auth.client.client_id)
    db.close()
    expect(auth.client.client_id).toBeTruthy()
    expect(new URL(auth.redirectUrl).port).toBe(String(own.oauthRedirectPort))
    expect(await c.saveProject(null, settings(binding), binding.ticket)).toMatchObject({ ok: false, code: 'binding_expired' })
    await c.stop()
    controller = new AppController(appDir!, plainSecrets, { ...host, openExternal() { throw new Error('restart must reuse authorization') } })
    await controller.start()
    expect(await controller.discoverProject(fake!.url, 'main')).toMatchObject({ ok: true, value: { projectId: 'prj_test' } })
  })

  it('rejects a foreign origin or missing branch before adding a project, and cancels only its temporary binding', async () => {
    const c = await setup()
    const discovered = await c.discoverProject(fake!.url)
    if (!discovered.ok) throw new Error(discovered.message)
    const b = discovered.value
    expect(await c.saveProject(null, { ...settings(b), startRef: 'origin/does-not-exist' }, b.ticket)).toMatchObject({ ok: false, code: 'repository_mismatch' })
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://example.com/other.git'], { cwd: world!.repoPath })
    expect(await c.saveProject(null, settings(b), b.ticket)).toMatchObject({ ok: false, code: 'repository_mismatch' })
    expect((await c.snapshot()).projects).toHaveLength(0)
    await c.cancelProjectBinding(b.ticket!)
    expect(readdirSync(join(appDir!, 'bindings'))).toHaveLength(0)
    expect(await c.saveProject(null, settings(b), b.ticket)).toMatchObject({ ok: false, code: 'binding_expired' })
  })

  it('cleans failed discovery, refuses missing and foreign subscriptions, and never starts intake', async () => {
    const c = await setup()
    fake!.resourcePages = [{ resources: [{ uri: 'ai-pm://projects/prj_foreign/work', name: 'foreign' }] }]
    expect(await c.discoverProject(fake!.url)).toMatchObject({ ok: false, code: 'discovery_failed' })
    expect((await c.snapshot()).projects).toHaveLength(0)
    expect(readdirSync(join(appDir!, 'bindings'))).toHaveLength(0)
    expect(fake!.callsOf('task_claim')).toHaveLength(0)
  })

  it('reads existing metadata without login, preserves tasks, scheduling and custom development branches', async () => {
    world = await makeWorld()
    world.fake.addTask('tsk_original')
    await untilState(world, 'task:tsk_original', 'needs_you', 'plan_confirm')
    await world.engine.stop()
    controller = new AppController(world.dataDir, plainSecrets, { ...host, openExternal() { throw new Error('existing read must not log in') } })
    await controller.start()
    const before = await controller.getSettings()
    const tasks = (await controller.snapshot()).tasks
    const read = await controller.discoverProject(world.fake.url, 'main')
    expect(read).toMatchObject({ ok: true, value: { projectId: 'prj_test' } })
    expect(await controller.getSettings()).toEqual(before)
    expect((await controller.snapshot()).tasks.map((t) => [t.key, t.status, t.worktree])).toEqual(tasks.map((t) => [t.key, t.status, t.worktree]))
    const changed = { ...before.projects[0].settings, projectId: 'prj_other' }
    expect(await controller.saveProject('main', changed)).toMatchObject({ ok: false, code: 'has_active_tasks' })
    expect(await controller.getSettings()).toEqual(before)
    expect(existsSync(world.dataDir)).toBe(true)
  })
})
