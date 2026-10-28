import { describe, expect, it } from 'vitest'
import { runCommand } from '../src/renderer/components/ui.js'

describe('running a command from a button', () => {
  it('stays busy until the window has reloaded, so a second click sees the new state', async () => {
    let reloaded!: () => void
    const reload = () => new Promise<void>((resolve) => { reloaded = resolve })
    const toasts: string[] = []
    let done = false
    const running = runCommand(Promise.resolve({ ok: true, value: undefined }), (text) => toasts.push(text), reload, '已返回开发修复')
      .then((ok) => { done = ok })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(done).toBe(false)
    reloaded()
    await running
    expect(done).toBe(true)
    expect(toasts).toEqual(['已返回开发修复'])
  })

  it('reports a refusal without reloading', async () => {
    let reloads = 0
    const toasts: [string, string | undefined][] = []
    const ok = await runCommand(Promise.resolve({ ok: false, code: 'wrong_state', message: '任务当前是 queued，不能执行这个操作' }),
      (text, tone) => toasts.push([text, tone]), async () => { reloads++ })
    expect(ok).toBe(false)
    expect(reloads).toBe(0)
    expect(toasts).toEqual([['任务当前是 queued，不能执行这个操作', 'danger']])
  })

  it('still counts as done when the reload fails', async () => {
    const ok = await runCommand(Promise.resolve({ ok: true, value: undefined }), () => {}, () => Promise.reject(new Error('gone')))
    expect(ok).toBe(true)
  })
})
