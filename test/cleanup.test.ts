import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeWorld, untilState, type World } from './helpers.js'

let world: World | null = null
afterEach(async () => {
  await world?.dispose()
  world = null
})

const DAY = 24 * 60 * 60_000

describe('finished checkouts', () => {
  it('are removed after the retention period, unless they hold uncommitted changes', async () => {
    world = await makeWorld({ settings: { worktreeRetentionDays: 14 } })
    const { engine } = world
    for (const id of ['tsk_old', 'tsk_dirty', 'tsk_recent']) {
      world.fake.addTask(id)
      await untilState(world, 'task:' + id, 'needs_you', 'plan_confirm')
    }
    const dirs = Object.fromEntries(['tsk_old', 'tsk_dirty', 'tsk_recent'].map((id) => [id, world!.task('task:' + id).worktree!]))
    const { store } = engine
    for (const id of Object.keys(dirs)) {
      store.updateTask('task:' + id, (t) => {
        t.status = 'closed'
        t.reason = null
      })
    }
    const old = new Date(Date.now() - 15 * DAY).toISOString()
    for (const id of ['tsk_old', 'tsk_dirty']) store.db.prepare('UPDATE tasks SET updated_at = ? WHERE key = ?').run(old, 'task:' + id)
    writeFileSync(join(dirs.tsk_dirty, 'unsaved.txt'), 'work in progress\n')

    await engine.scheduler.cleanupWorktrees(true)

    expect(existsSync(dirs.tsk_old)).toBe(false)
    expect(world.task('task:tsk_old').worktree).toBeNull()
    expect(existsSync(dirs.tsk_dirty)).toBe(true)
    expect(existsSync(dirs.tsk_recent)).toBe(true)
    const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: world.repoPath, encoding: 'utf8' })
    expect(listed).not.toContain(dirs.tsk_old)
    expect(listed).toContain(dirs.tsk_recent)
    // The branch stays; only the checkout went.
    expect(execFileSync('git', ['branch', '--list', 'ai-pm/tsk_old'], { cwd: world.repoPath, encoding: 'utf8' })).toContain('ai-pm/tsk_old')
  })
})
