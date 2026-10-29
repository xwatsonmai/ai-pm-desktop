import { expect, it } from 'vitest'
import { readCatalog } from '../src/renderer/model-catalog.js'

it('ends loading on empty catalogs, rejected IPC, business errors and missing replies, and allows a later successful retry', async () => {
  expect(await readCatalog(async () => ({ ok: true, value: [] }))).toMatchObject({ models: null, error: expect.stringContaining('登录') })
  expect(await readCatalog(async () => { throw Error('reply was never sent') })).toMatchObject({ error: expect.stringContaining('reply was never sent') })
  expect(await readCatalog(async () => ({ ok: false, code: 'failed', message: 'not logged in' }))).toMatchObject({ error: 'not logged in' })
  expect(await readCatalog(() => new Promise(() => {}), 10)).toMatchObject({ error: expect.stringContaining('超时') })
  const models = [{ id: 'provider::model', name: 'model', efforts: [], defaultEffort: null, isDefault: true }]
  expect(await readCatalog(async () => ({ ok: true, value: models }))).toEqual({ models, error: null })
})
