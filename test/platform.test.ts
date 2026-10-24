import { afterEach, describe, expect, it } from 'vitest'
import { McpPlatform, PlatformError, StaticToken } from '../src/core/platform/client.js'
import { Outbox } from '../src/core/platform/outbox.js'
import { Store } from '../src/core/store.js'
import { DEFAULT_TIMING } from '../src/core/types.js'
import { FakePlatform, TOKEN } from './fake-platform.js'

let fake: FakePlatform
let platform: McpPlatform

afterEach(async () => {
  await platform?.close()
  await fake?.stop()
})

async function setup() {
  fake = new FakePlatform('http://git.example/repo.git')
  await fake.start()
  platform = new McpPlatform(fake.url, fake.resourceUri, new StaticToken(TOKEN), 5_000)
}

describe('McpPlatform', () => {
  it('calls tools and classifies business rejections', async () => {
    await setup()
    fake.addTask('t1')
    const context = await platform.call('project_get_context', {})
    expect(context.project.id).toBe('prj_test')
    const work = await platform.call('work_list', {})
    expect(work.tasks.map((t: any) => t.id)).toEqual(['t1'])
    const error = await platform.call('task_report_work', { task_id: 't1', claim_id: 'nope', body: 'x', request_id: 'r1' }).catch((e) => e)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error.kind).toBe('rejected')
    expect(error.code).toBe('claim_invalid')
  })

  it('reports a bad token as an auth error', async () => {
    fake = new FakePlatform('repo')
    await fake.start()
    platform = new McpPlatform(fake.url, fake.resourceUri, new StaticToken('wrong'), 5_000)
    const error = await platform.call('work_list', {}).catch((e) => e)
    expect(error.kind).toBe('auth')
  })

  it('streams subscription acknowledgements and updates', async () => {
    await setup()
    const controller = new AbortController()
    let acks = 0
    let updates = 0
    const listening = platform.listen({ onAck: () => acks++, onUpdate: () => updates++ }, controller.signal)
    await expect.poll(() => acks).toBe(1)
    fake.addTask('t2')
    await expect.poll(() => updates).toBeGreaterThan(0)
    controller.abort()
    await listening
  })
})

describe('Outbox', () => {
  it('resends a lost response with the same request_id and the platform applies it once', async () => {
    await setup()
    fake.addTask('t1')
    fake.faults.push({ tool: 'task_claim', kind: 'drop_response' })
    const store = new Store(':memory:')
    const timing = { ...DEFAULT_TIMING, backoffMs: [0] }
    const outbox = new Outbox(store, platform, new StaticToken(TOKEN), () => timing)
    const id = store.enqueue({ taskKey: 'task:t1', tool: 'task_claim', params: { task_id: 't1' }, effect: 'claimed' })
    const done: any[] = []
    const handlers = { onDone: (_: any, result: any) => done.push(result), onRejected: () => {}, onHandlerError: (_: any, e: unknown) => { throw e } }
    await outbox.flush(handlers)
    expect(done).toHaveLength(0)
    expect(store.getOutbox(id)!.attempts).toBe(1)
    await outbox.flush(handlers)
    expect(done).toHaveLength(1)
    expect(done[0].claim_id).toBe(fake.tasks.get('t1')!.claim_id)
    expect(fake.callsOf('task_claim').map((c) => c.args.request_id)).toEqual([id, id])
  })

  it('marks a business rejection without retrying', async () => {
    await setup()
    fake.addTask('t1')
    const store = new Store(':memory:')
    const outbox = new Outbox(store, platform, new StaticToken(TOKEN), () => DEFAULT_TIMING)
    const id = store.enqueue({ taskKey: 'task:t1', tool: 'task_submit_result', params: { task_id: 't1', claim_id: 'x' }, effect: 'submitted' })
    const rejected: PlatformError[] = []
    await outbox.flush({ onDone: () => {}, onRejected: (_, e) => rejected.push(e), onHandlerError: () => {} })
    expect(rejected[0].code).toBe('claim_invalid')
    expect(store.getOutbox(id)!.status).toBe('rejected')
  })
})
