import { afterEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { listZcodeModels } from '../src/core/executors/zcode-models.js'
import { fakeExecutor, until } from './helpers.js'
import * as account from '../src/core/executors/zcode-account.js'

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), rm: vi.fn().mockRejectedValue(Object.assign(new Error('directory busy'), { code: 'EBUSY' })) }))
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(rm).mockClear(); vi.restoreAllMocks() })

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

it('synchronizes account entitlement before creating the discovery session; rejected sync remains retryable', async () => {
  const snapshot = vi.fn().mockResolvedValue({ providers: { native: { access: { entitled: true } } } })
  vi.spyOn(account, 'createZcodeAccountBridge').mockReturnValue({ snapshot, headers: vi.fn() })
  vi.stubEnv('FAKE_ZCODE_REQUIRE_ACCOUNT', '1')
  vi.stubEnv('FAKE_ZCODE_ACCOUNT_REJECT', '1')
  await expect(listZcodeModels(fakeExecutor('zcode'))).rejects.toThrow('不支持账号同步')
  vi.stubEnv('FAKE_ZCODE_ACCOUNT_REJECT', '0')
  expect(await listZcodeModels(fakeExecutor('zcode'))).toHaveLength(2)
  expect(snapshot).toHaveBeenCalledTimes(2)
})

it('cancels slow account discovery on timeout so a late login result cannot create a session', async () => {
  let signal: AbortSignal | undefined
  vi.spyOn(account, 'createZcodeAccountBridge').mockImplementation((options) => {
    signal = options.signal
    return { snapshot: () => new Promise(() => {}), headers: vi.fn() }
  })
  await expect(listZcodeModels(fakeExecutor('zcode'), 100)).rejects.toThrow('超时')
  expect(signal?.aborted).toBe(true)
})
