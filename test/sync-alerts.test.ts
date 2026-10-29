import { afterEach, expect, it } from 'vitest'
import { makeWorld, until, untilState, type World } from './helpers.js'

let world: World | null = null
const key = 'task:tsk_1'
afterEach(async () => { await world?.dispose(); world = null })

async function waiting() {
  world = await makeWorld()
  world.fake.addTask('tsk_1')
  await untilState(world, key, 'needs_you', 'plan_confirm')
  world.fake.update('tsk_1', (t) => { t.status = 'review' })
  world.engine.store.updateTask(key, (t) => { t.stage = 'release'; t.status = 'waiting'; t.reason = 'acceptance' })
  return world
}

it('records consecutive synchronization faults separately, recovers automatically and preserves execution errors and history', async () => {
  const w = await waiting()
  w.engine.store.updateTask(key, (t) => { t.failures = 3; t.lastError = 'git worktree preparation failed' })
  w.fake.brokenContext.add('tsk_1')
  await until(() => w.task(key).data.syncIssue?.failures ?? 0, (n) => n >= 3, 'three failed reads')
  expect(w.task(key)).toMatchObject({ failures: 3, lastError: 'git worktree preparation failed', status: 'waiting', reason: 'acceptance' })
  const history = w.engine.store.events(key).filter((e) => e.type === 'sync_error')
  expect(history.length).toBeGreaterThanOrEqual(3)
  w.fake.brokenContext.delete('tsk_1')
  await until(() => w.task(key).data.syncIssue, (issue) => !issue, 'successful sync clears only synchronization alarm')
  expect(w.task(key)).toMatchObject({ failures: 3, lastError: 'git worktree preparation failed' })
  expect(w.engine.store.events(key).filter((e) => e.type === 'sync_error')).toHaveLength(history.length)
  expect(w.engine.store.events(key).filter((e) => e.type === 'sync_recovered')).toHaveLength(1)
  expect(w.invocations()).toHaveLength(1) // no new agent or repeated release
  await w.restart()
  expect(w.task(key).data.syncIssue).toBeUndefined()
  expect(w.task(key).failures).toBe(3)
})

it('migrates recognizable legacy acceptance network alarms once and waits for a real successful read to clear them', async () => {
  const w = await waiting()
  const message = 'MCP error -32001: Request timed out'
  w.fake.brokenContext.add('tsk_1')
  w.engine.store.updateTask(key, (t) => { t.failures = 4; t.lastError = message })
  w.engine.store.event(key, 'error', message)
  w.engine.store.db.prepare('DELETE FROM settings WHERE key=?').run('migration:separate_sync_errors_v1')
  await w.restart()
  expect(w.task(key)).toMatchObject({ failures: 0, lastError: null, status: 'waiting', reason: 'acceptance' })
  expect(w.task(key).data.syncIssue?.failures).toBeGreaterThanOrEqual(4)
  expect(w.engine.store.events(key).filter((e) => e.type === 'sync_migrated')).toHaveLength(1)
  await w.engine.command('retryNow', key)
  expect(w.task(key).data.syncIssue).toBeTruthy() // clicking retry is not evidence of recovery
  w.fake.brokenContext.delete('tsk_1')
  await until(() => w.task(key).data.syncIssue, (issue) => !issue, 'recovered legacy alarm')
  await w.restart()
  expect(w.task(key).data.syncIssue).toBeUndefined()
  expect(w.engine.store.events(key).filter((e) => e.type === 'sync_migrated')).toHaveLength(1)
  expect(w.engine.store.events(key).some((e) => e.type === 'error' && e.message === message)).toBe(true)
})

it('does not migrate or clear an execution fault without matching legacy synchronization evidence', async () => {
  const w = await waiting()
  w.engine.store.updateTask(key, (t) => { t.failures = 3; t.lastError = 'failed to read executor log' })
  w.engine.store.event(key, 'error', 'failed to read executor log')
  w.engine.store.db.prepare('DELETE FROM settings WHERE key=?').run('migration:separate_sync_errors_v1')
  await w.restart()
  expect(w.task(key)).toMatchObject({ failures: 3, lastError: 'failed to read executor log' })
  expect(w.task(key).data.syncIssue).toBeUndefined()
})
