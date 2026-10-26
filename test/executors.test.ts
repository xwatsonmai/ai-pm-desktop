import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { replyJson, zcodeMcpServers, zcodeModel } from '../src/core/executors/zcode.js'
import { listZcodeModels } from '../src/core/executors/zcode-models.js'
import type { ExecutorName } from '../src/core/types.js'
import { fakeExecutor, makeWorld, until, untilState, type World } from './helpers.js'

let world: World | null = null
afterEach(async () => {
  await world?.dispose()
  world = null
})

const KEY = 'task:tsk_1'

async function toReadyToTest(w: World) {
  w.fake.addTask('tsk_1')
  await untilState(w, KEY, 'needs_you', 'plan_confirm')
  await w.engine.command('confirmPlan', KEY, {})
  return untilState(w, KEY, 'needs_you', 'ready_to_test')
}

describe.each<ExecutorName>(['claude', 'zcode'])('%s executor', (executor) => {
  it('takes a requirement from plan to release', async () => {
    world = await makeWorld({ executor })
    const { fake } = world
    fake.addTask('tsk_1', '订单列表加筛选')
    const planned = await untilState(world, KEY, 'needs_you', 'plan_confirm')
    expect(planned.executor).toBe(executor)
    expect(planned.data.plan).toMatchObject({ summary: '方案摘要' })

    await world.engine.command('confirmPlan', KEY, {})
    const developed = await untilState(world, KEY, 'needs_you', 'ready_to_test')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: developed.worktree!, encoding: 'utf8' }).trim()
    expect(developed.data.dev!.sha).toBe(head)

    await world.engine.command('submitTest', [KEY])
    await untilState(world, KEY, 'waiting', 'testing')
    fake.passTest('tsk_1')
    await untilState(world, KEY, 'needs_you', 'ready_to_release')
    await world.engine.command('release', [KEY])
    await untilState(world, KEY, 'waiting', 'acceptance')
    fake.accept('tsk_1')
    await untilState(world, KEY, 'done')

    const calls = world.invocations()
    expect(calls.map((c) => c.executor)).toEqual([executor, executor, executor, executor])
    expect(calls.map((c) => c.stage)).toEqual(['plan', 'develop', 'test_release', 'release'])
    expect(calls.map((c) => c.readOnly)).toEqual([true, false, false, false])
  })

  it('resumes the same session after the agent process crashes', async () => {
    world = await makeWorld({ executor, scenario: { develop: [{ type: 'crash' }] } })
    await toReadyToTest(world)
    const develop = world.invocations().filter((c) => c.stage === 'develop')
    expect(develop.map((c) => c.purpose)).toEqual(['start', 'resume'])
    expect(develop[1].session).toBe(develop[0].session)
  })

  it('sends a malformed result back to the same session for correction', async () => {
    world = await makeWorld({ executor, scenario: { plan: [{ type: 'invalid' }] } })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    const plan = world.invocations().filter((c) => c.stage === 'plan')
    expect(plan.map((c) => c.purpose)).toEqual(['start', 'repair'])
    expect(plan[1].session).toBe(plan[0].session)
  })

  it('picks up a run that kept going while the client restarted', async () => {
    world = await makeWorld({ executor, scenario: { develop: [{ type: 'hang', ms: 1_500 }] } })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    await world.engine.command('confirmPlan', KEY, {})
    await untilState(world, KEY, 'running')
    await world.restart()
    await untilState(world, KEY, 'needs_you', 'ready_to_test')
    expect(world.invocations().filter((c) => c.stage === 'develop')).toHaveLength(1)
  })

  it('stops the agent when the requirement is cancelled', async () => {
    world = await makeWorld({ executor, scenario: { plan: [{ type: 'hang', ms: 60_000 }] } })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'running')
    const run = await until(() => world!.engine.store.openRuns()[0], Boolean, 'open run')
    world.fake.cancel('tsk_1')
    await untilState(world, KEY, 'closed')
    await until(() => {
      try {
        process.kill(run.pid, 0)
        return false
      } catch {
        return true
      }
    }, Boolean, 'agent process gone')
  })

  it('passes the chosen model and effort to the CLI', async () => {
    const model = executor === 'zcode' ? 'prov-a::glm-fake' : 'opus'
    world = await makeWorld({
      executor,
      settings: { executors: { [executor]: { ...fakeExecutor(executor), models: { expert: { model, effort: 'max' } } } } },
    })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    const [plan] = world.invocations()
    if (executor === 'zcode') expect(plan.config).toEqual(['model=prov-a::glm-fake', 'effort=max', 'deny=ExitPlanMode', 'deny=EnterPlanMode', 'deny=AskUserQuestion'])
    else expect(plan.config).toEqual(expect.arrayContaining(['--model=opus', '--effort=max', '--permission-mode=dontAsk']))
  })
})

describe('Claude Code specifics', () => {
  it('keeps read-only runs to reading tools and leaves out the user config', async () => {
    world = await makeWorld({ executor: 'claude' })
    world.fake.addTask('tsk_1')
    await untilState(world, KEY, 'needs_you', 'plan_confirm')
    await world.engine.command('confirmPlan', KEY, {})
    await untilState(world, KEY, 'needs_you', 'ready_to_test')
    const [plan, develop] = world.invocations()
    expect(plan.config).toEqual(expect.arrayContaining(['--setting-sources=project,local', 'allow=Read', 'allow=Bash(git log:*)']))
    expect(plan.config.some((c: string) => /allow=(Edit|Write)/.test(c))).toBe(false)
    expect(develop.config).toContain('--permission-mode=bypassPermissions')
  })
})

describe('ZCode specifics', () => {
  it('reads the JSON out of a reply wrapped in prose or a fence', () => {
    expect(replyJson('{"a":1}')).toBe('{"a":1}')
    expect(replyJson('结果如下：\n```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(replyJson('好的 {"a":{"b":2}} 完成')).toBe('{"a":{"b":2}}')
    expect(replyJson('没有 JSON')).toBe('没有 JSON')
  })

  it('names models by provider and model, and maps MCP servers to its format', () => {
    expect(zcodeModel('prov::z-ai/glm-5.2', 'max')).toEqual({ providerId: 'prov', modelId: 'z-ai/glm-5.2', options: { reasoningLevel: 'max' } })
    expect(zcodeModel('glm', undefined)).toBeUndefined()
    expect(zcodeMcpServers('{"mcpServers":{"ops":{"type":"http","url":"http://ops/mcp","headers":{"Authorization":"Bearer x"}}}}')).toEqual([
      { name: 'ops', type: 'http', url: 'http://ops/mcp', isolation: 'session', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
    ])
  })

  it('lists the models ZCode offers without sending a prompt', async () => {
    const models = await listZcodeModels(fakeExecutor('zcode'))
    expect(models).toEqual([
      { id: 'prov-a::glm-fake', name: 'glm-fake（Z.AI）', efforts: ['low', 'max'], defaultEffort: 'max', isDefault: true },
      { id: 'prov-b::z-ai/other', name: 'z-ai/other（英伟达）', efforts: ['enabled'], defaultEffort: 'enabled', isDefault: false },
    ])
  })
})
