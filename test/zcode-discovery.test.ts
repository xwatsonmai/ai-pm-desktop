import { afterEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { listZcodeModels } from '../src/core/executors/zcode-models.js'
import { fakeExecutor, until } from './helpers.js'

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), rm: vi.fn().mockRejectedValue(Object.assign(new Error('directory busy'), { code: 'EBUSY' })) }))
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(rm).mockClear() })

it('settles empty and populated results despite Windows cleanup errors and retries after login', async () => {
  vi.stubEnv('FAKE_ZCODE_EMPTY_MODELS', '1')
  expect(await listZcodeModels(fakeExecutor('zcode'))).toEqual([])
  await until(() => vi.mocked(rm).mock.calls.length, (n) => n > 0, 'cleanup after child close')
  expect(rm).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ maxRetries: 5 }))
  vi.stubEnv('FAKE_ZCODE_EMPTY_MODELS', '0')
  expect(await listZcodeModels(fakeExecutor('zcode'))).toHaveLength(2)
})

it('settles timeouts and spawn failures even when directory cleanup fails', async () => {
  vi.stubEnv('FAKE_ZCODE_CREATE_HANG', '1')
  await expect(listZcodeModels(fakeExecutor('zcode'), 100)).rejects.toThrow('超时')
  await expect(listZcodeModels({ binary: '/nonexistent/zcode', limit: 1 })).rejects.toThrow()
})
