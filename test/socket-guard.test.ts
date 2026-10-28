import { describe, expect, it } from 'vitest'
import { guardTypeOfService } from '../src/core/platform/socket-guard.js'

const failing = (error: Error) => ({ setTypeOfService(_tos: number): unknown { throw error } })

describe('type of service guard', () => {
  it('ignores a socket refusing the setting, as macOS does once the server reset the connection', () => {
    const socket = failing(Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' }))
    guardTypeOfService(socket)
    expect(socket.setTypeOfService(0)).toBe(socket)
  })

  it('still throws for anything else', () => {
    const socket = failing(new RangeError('tos out of range'))
    guardTypeOfService(socket)
    expect(() => socket.setTypeOfService(999)).toThrow('tos out of range')
  })

  it('leaves a runtime without the setting alone', () => {
    const socket: { setTypeOfService?(tos: number): unknown } = {}
    guardTypeOfService(socket)
    expect(socket.setTypeOfService).toBeUndefined()
  })
})
