import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { liveness, processStartToken } from '../src/core/executors/process.js'

describe('liveness', () => {
  it('reports a running process with its start token as alive', () => {
    expect(liveness(process.pid, processStartToken(process.pid))).toBe('alive')
  })

  it('reports a finished process as dead', async () => {
    const child = spawn('true')
    await new Promise((resolve) => child.on('exit', resolve))
    expect(liveness(child.pid!, null)).toBe('dead')
  })

  it.skipIf(process.platform === 'win32')('treats a reused pid as dead', () => {
    expect(liveness(process.pid, 'Thu Jan  1 00:00:00 1970')).toBe('dead')
  })
})
