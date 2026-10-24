import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { listCodexModels } from '../src/core/executors/codex-models.js'
import { ModelPicker } from '../src/renderer/components/ModelPicker.js'
import { FAKE_CODEX } from './helpers.js'

describe('Codex model list', () => {
  it('reads every page of models with their reasoning efforts', async () => {
    const models = await listCodexModels(FAKE_CODEX)
    expect(models).toEqual([
      { id: 'fake-pro', name: 'Fake Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'low', isDefault: true },
      { id: 'fake-mini', name: 'Fake Mini', efforts: ['medium'], defaultEffort: 'medium', isDefault: false },
    ])
  })

  it('says why it could not read the list', async () => {
    await expect(listCodexModels('/nonexistent/codex')).rejects.toThrow()
    await expect(listCodexModels('/usr/bin/false')).rejects.toThrow('codex app-server 退出')
  })

  it('offers only the efforts the chosen model supports, and keeps an unknown saved value visible', () => {
    const models = [
      { id: 'fake-pro', name: 'Fake Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'low', isDefault: true },
      { id: 'fake-mini', name: 'Fake Mini', efforts: ['medium'], defaultEffort: 'medium', isDefault: false },
    ]
    const html = renderToStaticMarkup(<ModelPicker catalog={{ models, error: null }} value={{ model: 'fake-mini', effort: 'high' }} onChange={() => {}} />)
    expect(html).toContain('<option value="">Codex 默认（Fake Pro）</option>')
    expect(html).toContain('<option value="fake-mini" selected="">Fake Mini</option>')
    expect(html).toContain('<option value="medium">medium</option>')
    expect(html).not.toContain('<option value="max">')
    expect(html).toContain('high（这个模型不支持）')
    const old = renderToStaticMarkup(<ModelPicker catalog={{ models, error: null }} value={{ model: 'retired-model' }} onChange={() => {}} />)
    expect(old).toContain('retired-model（不在当前列表里）')
    const typed = renderToStaticMarkup(<ModelPicker catalog={{ models: null, error: '读不到模型列表：超时' }} value={{ model: 'x' }} onChange={() => {}} />)
    expect(typed).toContain('value="x"')
    expect(typed).not.toContain('disabled')
  })
})
