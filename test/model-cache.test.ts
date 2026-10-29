import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AppController } from '../src/main/controller.js'
import { plainSecrets } from '../src/core/store.js'
import { listZcodeModels } from '../src/core/executors/zcode-models.js'

vi.mock('../src/core/executors/zcode-models.js', () => ({ listZcodeModels: vi.fn() }))

it('does not cache logged-out empty results and bypasses a populated cache on explicit refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-pm-model-cache-'))
  const c = new AppController(dir, plainSecrets, { openExternal() {}, openPath() {}, copy() {}, launchAtLogin: () => false, setLaunchAtLogin() {} })
  const models = [{ id: 'provider::model', name: 'model', efforts: [], defaultEffort: null, isDefault: true }]
  vi.mocked(listZcodeModels).mockResolvedValueOnce([]).mockResolvedValueOnce(models).mockResolvedValueOnce([]).mockResolvedValueOnce(models)
  const config = { binary: 'zcode' }
  try {
    expect(await c.listModels('zcode', config)).toEqual({ ok: true, value: [] })
    expect(await c.listModels('zcode', config)).toEqual({ ok: true, value: models })
    expect(await c.listModels('zcode', config)).toEqual({ ok: true, value: models })
    expect(listZcodeModels).toHaveBeenCalledTimes(2)
    expect(await c.listModels('zcode', config, true)).toEqual({ ok: true, value: [] })
    expect(await c.listModels('zcode', config)).toEqual({ ok: true, value: models })
    expect(listZcodeModels).toHaveBeenCalledTimes(4)
  } finally { await c.stop(); rmSync(dir, { recursive: true, force: true }) }
})
