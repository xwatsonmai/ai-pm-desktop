import { execFileSync } from 'node:child_process'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Engine } from '../src/core/engine.js'
import { pushTaskBranch } from '../src/core/publish.js'
import * as workspace from '../src/core/workspace.js'
import { makeWorld, untilState, type World } from './helpers.js'

let world: World | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await world?.dispose()
  world = null
})
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const KEY = 'task:tsk_1'
const BRANCH = 'ai-pm/tsk_1'
async function develop() {
  world!.fake.addTask('tsk_1')
  await untilState(world!, KEY, 'needs_you', 'plan_confirm')
  await world!.engine.command('confirmPlan', KEY, {})
}
function refuseTaskOne() {
  const hook = join(world!.origin, 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n if [ "$ref" = "refs/heads/ai-pm/tsk_1" ]; then echo denied >&2; exit 1; fi\ndone\n')
  chmodSync(hook, 0o755)
  return hook
}

it('publishes a task before reporting completion, without changing main', async () => {
  world = await makeWorld()
  const before = git(world.origin, 'rev-parse', 'main')
  await develop()
  const task = await untilState(world, KEY, 'needs_you', 'ready_to_test')
  expect(git(world.origin, 'rev-parse', 'refs/heads/' + BRANCH)).toBe(task.data.dev!.sha)
  expect(git(world.origin, 'rev-parse', 'main')).toBe(before)
  expect(task.data.pendingDev).toBeUndefined()
  expect(world.engine.store.events(KEY).some((e) => e.type === 'branch_pushed')).toBe(true)
})

it('keeps failed pushes separate from development and retries after restart without another agent run', async () => {
  world = await makeWorld()
  const hook = refuseTaskOne()
  await develop()
  const blocked = await untilState(world, KEY, 'needs_you', 'push_failed')
  expect(blocked.data.pendingDev?.sha).toMatch(/^[a-f0-9]{40}$/)
  expect(blocked.data.dev).toBeUndefined()
  expect(world.fake.callsOf('task_report_work').filter((c) => c.args.task_id === 'tsk_1' && String(c.args.body).startsWith('开发完成'))).toHaveLength(0)
  expect(world.invocations().filter((r) => r.stage === 'develop')).toHaveLength(1)
  await world.restart()
  await expect(world.engine.command('submitTest', [KEY])).rejects.toMatchObject({ code: 'wrong_state' })
  rmSync(hook)
  await world.engine.command('retry', KEY)
  const ready = await untilState(world, KEY, 'needs_you', 'ready_to_test')
  expect(ready.data.dev!.sha).toBe(blocked.data.pendingDev!.sha)
  expect(ready.sessions.develop).toBe(blocked.sessions.develop)
  expect(git(world.origin, 'rev-parse', BRANCH)).toBe(ready.data.dev!.sha)
  expect(world.invocations().filter((r) => r.stage === 'develop')).toHaveLength(1)
})

it('recovers a queued publication checkpoint without needing executor capacity', async () => {
  world = await makeWorld()
  const hook = refuseTaskOne()
  await develop()
  const blocked = await untilState(world, KEY, 'needs_you', 'push_failed')
  await world.engine.stop()
  // Model a shutdown after the development result was checkpointed, before push completed.
  const { Store } = await import('../src/core/store.js')
  const store = new Store(join(world.dataDir, 'db.sqlite'))
  store.updateTask(KEY, (t) => { t.status = 'queued'; t.reason = null })
  const settings = store.getSettings()!
  store.setSettings({ ...settings, allowedExecutors: [] })
  store.close()
  rmSync(hook)
  world.engine = new Engine({ dataDir: world.dataDir })
  await world.engine.start()
  const ready = await untilState(world, KEY, 'needs_you', 'ready_to_test')
  expect(ready.data.dev!.sha).toBe(blocked.data.pendingDev!.sha)
  expect(world.invocations().filter((r) => r.stage === 'develop')).toHaveLength(1)
})

it('one rejected branch does not stop another task from being developed and pushed', async () => {
  world = await makeWorld()
  refuseTaskOne()
  await develop()
  await untilState(world, KEY, 'needs_you', 'push_failed')
  world.fake.addTask('tsk_2')
  await untilState(world, 'task:tsk_2', 'needs_you', 'plan_confirm')
  await world.engine.command('confirmPlan', 'task:tsk_2', {})
  const second = await untilState(world, 'task:tsk_2', 'needs_you', 'ready_to_test')
  expect(git(world.origin, 'rev-parse', 'ai-pm/tsk_2')).toBe(second.data.dev!.sha)
})

it('recognizes a push accepted remotely even when the acknowledgement was lost', async () => {
  world = await makeWorld()
  const original = workspace.git
  let lost = false
  vi.spyOn(workspace, 'git').mockImplementation(async (...args) => {
    const value = await original(...args)
    if (args[1][0] === 'push' && !lost) { lost = true; throw new Error('connection lost after push') }
    return value
  })
  await develop()
  const task = await untilState(world, KEY, 'needs_you', 'ready_to_test')
  expect(lost).toBe(true)
  expect(git(world.origin, 'rev-parse', BRANCH)).toBe(task.data.dev!.sha)
})

it('refuses divergent remote history and never force-pushes it', async () => {
  world = await makeWorld()
  const repo = world.repoPath
  git(repo, 'checkout', '-qb', BRANCH)
  writeFileSync(join(repo, 'ours.txt'), 'ours')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'ours')
  const ours = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  writeFileSync(join(repo, 'theirs.txt'), 'theirs')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'theirs')
  const theirs = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/' + BRANCH)
  await expect(pushTaskBranch(repo, BRANCH, ours, world.origin)).rejects.toThrow()
  expect(git(world.origin, 'rev-parse', BRANCH)).toBe(theirs)
  await expect(pushTaskBranch(repo, 'main', theirs, world.origin)).rejects.toThrow('任务分支')
  await expect(pushTaskBranch(repo, BRANCH, ours, world.origin + '-other')).rejects.toThrow('不一致')
})


it('accepts a remotely advanced requirement branch without replacing its newer commit', async () => {
  world = await makeWorld()
  await develop()
  const ready = await untilState(world, KEY, 'needs_you', 'ready_to_test')
  const checkout = join(world.root, 'concurrent-fix')
  git(world.repoPath, 'worktree', 'add', '--detach', checkout, ready.data.dev!.sha)
  writeFileSync(join(checkout, 'fix.txt'), 'another verified fix')
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'concurrent fix')
  const advanced = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'push', '-q', 'origin', 'HEAD:refs/heads/' + BRANCH)
  expect(await pushTaskBranch(ready.worktree!, BRANCH, ready.data.dev!.sha, world.origin)).toBe(advanced)
  expect(git(world.origin, 'rev-parse', BRANCH)).toBe(advanced)
})

it('blocks a parent push when its changed submodule commit is not remotely readable', async () => {
  world = await makeWorld()
  const repo = world.repoPath
  git(repo, 'checkout', '-qb', BRANCH)
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', world.origin, 'mobile')
  const mobile = join(repo, 'mobile')
  git(mobile, 'config', 'user.name', 'Test'); git(mobile, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(mobile, 'private.txt'), 'not published yet')
  git(mobile, 'add', '.'); git(mobile, 'commit', '-qm', 'unpublished submodule change')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'parent with unpublished submodule')
  await expect(pushTaskBranch(repo, BRANCH, git(repo, 'rev-parse', 'HEAD'), world.origin)).rejects.toThrow()
  expect(git(world.origin, 'ls-remote', world.origin, 'refs/heads/' + BRANCH)).toBe('')
})

it('can explicitly hand a push conflict back to development while ordinary retry only pushes', async () => {
  world = await makeWorld()
  const hook = refuseTaskOne()
  await develop()
  const blocked = await untilState(world, KEY, 'needs_you', 'push_failed')
  rmSync(hook)
  await world.engine.command('answer', KEY, '检查远端分支，保留已有修改后再测试')
  const ready = await untilState(world, KEY, 'needs_you', 'ready_to_test')
  const runs = world.invocations().filter((r) => r.stage === 'develop')
  expect(runs).toHaveLength(2)
  expect(ready.sessions.develop).toBe(blocked.sessions.develop)
  expect(runs[1].prompt).toContain('推送时遇到问题')
  expect(ready.data.pendingDev).toBeUndefined()
  expect(git(world.origin, 'rev-parse', BRANCH)).toBe(ready.data.dev!.sha)
})
