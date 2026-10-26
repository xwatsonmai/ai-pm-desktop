import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDetachedWorktree } from '../src/core/workspace.js'
import type { Task } from '../src/core/types.js'
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
    await engine.scheduler.cleanupWorktrees(true)

    expect(existsSync(dirs.tsk_old)).toBe(false)
    expect(world.task('task:tsk_old').worktree).toBeNull()
    expect(existsSync(dirs.tsk_dirty)).toBe(true)
    // Kept for its changes, said once however often cleanup runs.
    expect(store.events('task:tsk_dirty').filter((e) => e.type === 'worktree_kept')).toHaveLength(1)
    expect(existsSync(dirs.tsk_recent)).toBe(true)
    const listed = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: world.repoPath, encoding: 'utf8' })
    expect(listed).not.toContain(dirs.tsk_old)
    expect(listed).toContain(dirs.tsk_recent)
    // The branch stays; only the checkout went.
    expect(execFileSync('git', ['branch', '--list', 'ai-pm/tsk_old'], { cwd: world.repoPath, encoding: 'utf8' })).toContain('ai-pm/tsk_old')
  })

  // A release checkout starts detached; a branch the release agent made there
  // goes with it once the branch's commits are on the remote.
  it('removes a branch the release agent made once it is pushed, and keeps an unpushed one', async () => {
    world = await makeWorld()
    const { engine, repoPath } = world
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const batch = (id: string) => ({ key: 'batch:' + id, kind: 'batch', platformId: id, stage: 'release', status: 'done', worktree: null, data: {} }) as unknown as Task
    const made: Record<string, string> = {}
    for (const [id, push] of [['aaaaaaaa-1', true], ['bbbbbbbb-2', false]] as const) {
      const task = batch(id)
      const dir = engine.scheduler.checkoutDir(task)
      await ensureDetachedWorktree({ repoPath, dir, baseRef: 'origin/main' })
      const branch = 'release/' + id.slice(0, 8)
      git(dir, 'switch', '-q', '-c', branch)
      writeFileSync(join(dir, 'RELEASE.md'), id + '\n')
      git(dir, 'add', '.')
      git(dir, 'commit', '-q', '-m', 'release record')
      if (push) git(dir, 'push', '-q', 'origin', branch)
      made[id] = branch
      expect(await engine.scheduler.removeCheckout(task)).toBe('removed')
      expect(existsSync(dir)).toBe(false)
    }
    expect(git(repoPath, 'branch', '--list', made['aaaaaaaa-1'])).toBe('')
    expect(engine.store.events('batch:aaaaaaaa-1').map((e) => e.type)).toContain('branch_removed')
    expect(git(repoPath, 'branch', '--list', made['bbbbbbbb-2'])).toContain(made['bbbbbbbb-2'])
    expect(engine.store.events('batch:bbbbbbbb-2').map((e) => e.type)).toContain('branch_kept')
  })
})

describe('deleting a workspace now', () => {
  it('only for a finished task, asks before discarding changes, and takes its own releases along', async () => {
    world = await makeWorld()
    const { engine } = world
    world.fake.addTask('tsk_1')
    await untilState(world, 'task:tsk_1', 'needs_you', 'plan_confirm')
    await expect(engine.command('removeWorkspace', 'task:tsk_1')).rejects.toMatchObject({ code: 'wrong_state' })

    const own = world.task('task:tsk_1').worktree!
    engine.store.updateTask('task:tsk_1', (t) => {
      t.status = 'done'
      t.reason = null
    })
    // A finished release made for this requirement alone.
    const release = { key: 'batch:cccccccc-3', kind: 'batch', platformId: 'cccccccc-3', stage: 'test_release', status: 'done', reason: null,
      data: { members: ['task:tsk_1'] } } as unknown as Task
    engine.store.saveTask({ ...world.task('task:tsk_1'), ...release, worktree: null, branch: null, sessions: {} })
    const releaseDir = engine.scheduler.checkoutDir(release)
    await ensureDetachedWorktree({ repoPath: world.repoPath, dir: releaseDir, baseRef: 'origin/main' })

    writeFileSync(join(own, 'notes.txt'), 'draft\n')
    await expect(engine.command('removeWorkspace', 'task:tsk_1')).rejects.toMatchObject({ code: 'workspace_dirty' })
    expect(existsSync(own)).toBe(true)

    await engine.command('removeWorkspace', 'task:tsk_1', true)
    expect(existsSync(own)).toBe(false)
    expect(existsSync(releaseDir)).toBe(false)
    expect(world.task('task:tsk_1').worktree).toBeNull()
    expect(engine.store.events('task:tsk_1').find((e) => e.type === 'you')?.message).toBe('删除了工作区，丢弃了未提交的改动')
  })
})

