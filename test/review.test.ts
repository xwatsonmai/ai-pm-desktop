import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeExecutor, makeWorld, untilState, type World } from './helpers.js'

let world: World | null = null
afterEach(async () => {
  await world?.dispose()
  world = null
})

const KEY = 'task:tsk_1'

// Codex develops; Claude Code and ZCode are there to review.
async function developed() {
  world = await makeWorld({
    settings: {
      executors: {
        codex: fakeExecutor('codex'),
        claude: { ...fakeExecutor('claude'), models: { expert: { model: 'opus', effort: 'high' } } },
        zcode: fakeExecutor('zcode'),
      },
      allowedExecutors: ['codex'],
    },
  })
  world.fake.addTask('tsk_1', '订单导出加退款状态')
  await untilState(world, KEY, 'needs_you', 'plan_confirm')
  await world.engine.command('confirmPlan', KEY, {})
  return untilState(world, KEY, 'needs_you', 'ready_to_test')
}

const calls = (stage: string) => world!.invocations().filter((c) => c.stage === stage)

describe('AI review', () => {
  it('reviews on the chosen executor, sends ticked items back to development, and rechecks in the same session', async () => {
    const ready = await developed()
    await world!.engine.command('startReview', KEY, 'claude')
    const reviewed = await untilState(world!, KEY, 'needs_you', 'review_ready')

    // On Claude Code with its expert model, over the branch's commits; told not to change the code.
    const [first] = calls('review')
    expect(first).toMatchObject({ executor: 'claude', purpose: 'start', fullAccess: true })
    expect(first.prompt).toContain('本轮只评审：不要修改或提交工作区里的代码')
    expect(first.config).toEqual(expect.arrayContaining(['--model=opus', '--effort=high']))
    const scope = JSON.parse(readFileSync(join(ready.worktree!, '.ai-pm', 'review.json'), 'utf8'))
    expect(scope.head_sha).toBe(ready.data.dev!.sha)
    expect(scope.base_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(reviewed.data.reviews).toHaveLength(1)
    expect(reviewed.data.reviews![0]).toMatchObject({ round: 1, executor: 'claude', model: 'opus', verdict: 'issues', sha: ready.data.dev!.sha })
    // Reviewing and testing are alternatives.
    await expect(world!.engine.command('submitTest', [KEY])).rejects.toMatchObject({ code: 'wrong_state' })

    // Only the ticked item goes back, to the development session on Codex.
    await expect(world!.engine.command('applyReview', KEY, [])).rejects.toMatchObject({ code: 'nothing_chosen' })
    await world!.engine.command('applyReview', KEY, ['R1'], '顺便补一个导出测试')
    const fixed = await untilState(world!, KEY, 'needs_you', 'ready_to_test')
    const fix = calls('develop').at(-1)
    expect(fix).toMatchObject({ executor: 'codex', purpose: 'continue' })
    expect(fix.session).toBe(calls('develop')[0].session)
    expect(fix.prompt).toContain('[R1][必须修] 导出缺少空值判断')
    expect(fix.prompt).not.toContain('R2')
    expect(fix.prompt).toContain('顺便补一个导出测试')
    expect(fixed.data.reviews![0].decision).toMatchObject({ kind: 'fix', items: ['R1'] })

    // Reviewing again with the same executor rechecks in its own session.
    await world!.engine.command('startReview', KEY, 'claude')
    await untilState(world!, KEY, 'needs_you', 'review_ready')
    const recheck = calls('review').at(-1)
    expect(recheck).toMatchObject({ executor: 'claude', purpose: 'continue', session: first.session })
    expect(recheck.prompt).toContain('先复查这些条目是否修好')

    // The user disagrees: the same reviewer looks again with their notes.
    await world!.engine.command('rereview', KEY, 'R2 是团队约定的命名，不用改')
    const again = await untilState(world!, KEY, 'needs_you', 'review_ready')
    expect(calls('review').at(-1)).toMatchObject({ purpose: 'continue', session: first.session })
    expect(calls('review').at(-1).prompt).toContain('R2 是团队约定的命名，不用改')
    expect(again.data.reviews!.map((r) => r.round)).toEqual([1, 2, 3])

    // Nothing more to fix: straight on to the test release.
    await world!.engine.command('skipReview', KEY)
    await untilState(world!, KEY, 'waiting', 'testing')
    expect(world!.fake.tasks.get('tsk_1')!.submission).toMatchObject({ sha: fixed.data.dev!.sha })
    expect(world!.task(KEY).data.reviews!.at(-1)!.decision).toMatchObject({ kind: 'skip' })
  })

  it('starts a fresh session when another executor reviews', async () => {
    await developed()
    await world!.engine.command('startReview', KEY, 'claude')
    await untilState(world!, KEY, 'needs_you', 'review_ready')
    await world!.engine.command('applyReview', KEY, ['R1'])
    await untilState(world!, KEY, 'needs_you', 'ready_to_test')
    await world!.engine.command('startReview', KEY, 'zcode')
    const second = await untilState(world!, KEY, 'needs_you', 'review_ready')
    const [claude, zcode] = calls('review')
    expect(zcode).toMatchObject({ executor: 'zcode', purpose: 'start', fullAccess: true })
    expect(zcode.session).not.toBe(claude.session)
    expect(second.data.reviews!.map((r) => r.executor)).toEqual(['claude', 'zcode'])
    // The new reviewer learns what was found and fixed before.
    const scope = JSON.parse(readFileSync(join(second.worktree!, '.ai-pm', 'review.json'), 'utf8'))
    expect(scope.earlier_reviews[0]).toMatchObject({ round: 1, executor: 'claude', user_decision: { kind: 'fix', items: ['R1'] } })
  })

  it('refuses a reviewer that is not set up', async () => {
    world = await makeWorld()
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    await world.engine.command('confirmPlan', KEY, {})
    await untilState(world, KEY, 'needs_you', 'ready_to_test')
    await expect(world.engine.command('startReview', KEY, 'claude')).rejects.toMatchObject({ code: 'executor_not_configured' })
  })
})
