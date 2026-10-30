import { afterEach, expect, it, vi } from 'vitest'
import { CodexExecutor } from '../src/core/executors/codex.js'
import { makeWorld, type World } from './helpers.js'

let world: World | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await world?.dispose()
  world = null
})

it('discards a stale probe when settings request a new pass and notifies after recovery', async () => {
  world = await makeWorld()
  const engine = world.engine
  let finish!: (value: { ok: boolean; detail: string }) => void
  const pending = new Promise<{ ok: boolean; detail: string }>((resolve) => { finish = resolve })
  const probe = vi.spyOn(CodexExecutor.prototype, 'probe').mockReturnValueOnce(pending).mockResolvedValue({ ok: true, detail: 'new CLI' })
  const health: (boolean | undefined)[] = []
  engine.on('changed', () => health.push(engine.executorHealth().codex))
  const first = engine.refreshExecutors()
  const second = engine.refreshExecutors()
  expect(second).toBe(first)
  finish({ ok: false, detail: 'deleted CLI' })
  await second
  expect(probe).toHaveBeenCalledTimes(2)
  expect(engine.executorHealth().codex).toBe(true)
  expect(health).toContain(true)
  expect(health).not.toContain(false)
})

it('isolates a thrown probe and allows the next explicit refresh to recover', async () => {
  world = await makeWorld()
  vi.spyOn(CodexExecutor.prototype, 'probe').mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ ok: true, detail: 'ready' })
  await world.engine.refreshExecutors()
  expect(world.engine.executorHealth().codex).toBe(false)
  await world.engine.refreshExecutors()
  expect(world.engine.executorHealth().codex).toBe(true)
})
