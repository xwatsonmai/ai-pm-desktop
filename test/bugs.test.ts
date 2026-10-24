import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeWorld, until, untilState, type World } from './helpers.js'

let world: World | null = null
afterEach(async () => {
  await world?.dispose()
  world = null
})

const PARENT = 'task:tsk_1'
const BRANCH = 'ai-pm/tsk_1'
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const isAncestor = (w: World, sha: string, ref: string) => {
  try {
    git(w.repoPath, 'merge-base', '--is-ancestor', sha, ref)
    return true
  } catch {
    return false
  }
}

// The requirement is developed and in the product's test environment.
async function parentInTesting(w: World) {
  w.fake.addTask('tsk_1', '订单导出')
  await untilState(w, PARENT, 'needs_you', 'plan_confirm')
  await w.engine.command('confirmPlan', PARENT, {})
  await untilState(w, PARENT, 'needs_you', 'ready_to_test')
  await w.engine.command('submitTest', [PARENT])
  return untilState(w, PARENT, 'waiting', 'testing')
}

// Plan, confirm and fix one bug; returns it ready to be test-released.
async function fixBug(w: World, id: string) {
  const key = 'task:' + id
  await untilState(w, key, 'needs_you', 'plan_confirm', 20_000)
  await w.engine.command('confirmPlan', key, {})
  return untilState(w, key, 'needs_you', 'ready_to_test', 20_000)
}

// Resumed runs report their directory with symlinks resolved (/private/var on macOS).
const developRunsIn = (w: World, worktree: string) =>
  w.invocations().filter((c) => c.stage === 'develop' && realpathSync(c.cwd).startsWith(realpathSync(worktree)))

describe('bugs filed against a requirement', () => {
  it('fixes on the requirement branch and ships with the requirement after the retest', async () => {
    world = await makeWorld()
    const { fake } = world
    const parent = await parentInTesting(world)
    const tested = fake.tasks.get('tsk_1')!.submission!.sha as string

    fake.fileBug('tsk_1', 'bug_1')
    const fixed = await fixBug(world, 'bug_1')
    // The fix sits on the requirement branch, on top of the version the product tested.
    expect(git(world.repoPath, 'rev-parse', BRANCH)).toBe(fixed.data.dev!.sha)
    expect(git(parent.worktree!, 'rev-parse', 'HEAD')).toBe(fixed.data.dev!.sha)
    expect(isAncestor(world, tested, fixed.data.dev!.sha)).toBe(true)
    expect(fixed.data.integratedInto).toBe(BRANCH)
    // The requirement itself waits for its bugs instead of developing again.
    expect(world.task(PARENT)).toMatchObject({ status: 'waiting', reason: 'testing' })
    expect(developRunsIn(world, parent.worktree!)).toHaveLength(1)

    await world.engine.command('submitTest', ['task:bug_1'])
    await until(() => fake.tasks.get('bug_1')!.status, (s) => s === 'verifying', 'bug waits for verification')
    expect(fake.tasks.get('bug_1')!.submission!.sha).toBe(fixed.data.dev!.sha)
    // The test release deploys the requirement branch, which now carries the fix.
    const release = world.invocations().filter((c) => c.stage === 'test_release').at(-1)
    const items = JSON.parse(readFileSync(join(release.cwd, '.ai-pm', 'release.json'), 'utf8')).items
    expect(items).toMatchObject([{ task_id: 'bug_1', branch: BRANCH, sha: fixed.data.dev!.sha }])
    await untilState(world, 'task:bug_1', 'waiting', 'testing')

    fake.verifyBug('bug_1')
    const resolved = await untilState(world, 'task:bug_1', 'done')
    expect(resolved.data.resolvedBug).toBe(true)
    await until(() => world!.task(PARENT).detail ?? '', (d) => d.includes('复测'), 'parent waits for the retest')

    const retested = git(world.repoPath, 'rev-parse', BRANCH)
    fake.startRetest('tsk_1', retested)
    fake.passTest('tsk_1')
    const ready = await untilState(world, PARENT, 'needs_you', 'ready_to_release')
    expect(ready.data.submittedSha).toBe(retested)
    await world.engine.command('release', [PARENT])
    await untilState(world, PARENT, 'waiting', 'acceptance')
    expect(fake.tasks.get('tsk_1')!.deployment).toMatchObject({ sha: retested })
    expect(fake.calls.filter((c) => c.outcome === 'rejected')).toEqual([])
  })

  it('continues the same session when the product returns a fix, before or after verifying it', async () => {
    world = await makeWorld()
    const { fake } = world
    await parentInTesting(world)
    fake.fileBug('tsk_1', 'bug_1')
    const first = await fixBug(world, 'bug_1')
    await world.engine.command('submitTest', ['task:bug_1'])
    await untilState(world, 'task:bug_1', 'waiting', 'testing')

    fake.returnBug('bug_1')
    const second = await untilState(world, 'task:bug_1', 'needs_you', 'ready_to_test')
    expect(second.data.dev!.sha).not.toBe(first.data.dev!.sha)
    expect(git(world.repoPath, 'rev-parse', BRANCH)).toBe(second.data.dev!.sha)

    await world.engine.command('submitTest', ['task:bug_1'])
    await untilState(world, 'task:bug_1', 'waiting', 'testing')
    fake.verifyBug('bug_1')
    await untilState(world, 'task:bug_1', 'done')
    // Found broken again while the requirement is still being tested.
    fake.returnBug('bug_1')
    const third = await untilState(world, 'task:bug_1', 'needs_you', 'ready_to_test')
    expect(third.data.resolvedBug).toBe(false)
    expect(git(world.repoPath, 'rev-parse', BRANCH)).toBe(third.data.dev!.sha)

    const runs = developRunsIn(world, first.worktree!)
    expect(runs.map((c) => c.purpose)).toEqual(['start', 'continue', 'continue'])
    expect(new Set(runs.map((c) => c.session)).size).toBe(1)
  })

  it('merges a second fix into a branch that already took the first', async () => {
    world = await makeWorld({ limit: 2 })
    const { fake } = world
    await parentInTesting(world)
    fake.fileBug('tsk_1', 'bug_1')
    fake.fileBug('tsk_1', 'bug_2')
    const [one, two] = [await fixBug(world, 'bug_1'), await fixBug(world, 'bug_2')]
    for (const fix of [one, two]) expect(isAncestor(world, fix.data.dev!.sha, BRANCH)).toBe(true)
  })

  it('asks the agent to resolve a conflicting merge, then asks you', async () => {
    const edit = { type: 'ok', file: 'shared.txt' }
    world = await makeWorld({ scenario: { develop: Array(10).fill(edit) } })
    const { fake } = world
    await parentInTesting(world)
    fake.fileBug('tsk_1', 'bug_1')
    const first = await fixBug(world, 'bug_1')
    fake.fileBug('tsk_1', 'bug_2')
    await untilState(world, 'task:bug_2', 'needs_you', 'plan_confirm', 20_000)
    await world.engine.command('confirmPlan', 'task:bug_2', {})
    const stuck = await untilState(world, 'task:bug_2', 'needs_you', 'merge_failed', 20_000)

    expect(developRunsIn(world, stuck.worktree!).map((c) => c.purpose)).toEqual(['start', 'continue', 'continue'])
    // Nothing half-merged anywhere: the branch still has only the first fix.
    expect(git(world.repoPath, 'rev-parse', BRANCH)).toBe(first.data.dev!.sha)
    expect(git(stuck.worktree!, 'status', '--porcelain')).toBe('')
  })
})
