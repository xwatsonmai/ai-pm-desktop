import { expect, it } from 'vitest'
import { resolveZcodeSelection } from '../src/core/executors/zcode-selection.js'
const a = { providerId: 'account:bigmodel', modelId: 'GLM-5.3' }
const b = { providerId: 'custom', modelId: 'other' }
const state = {
  session: { model: { ...a, options: { reasoningLevel: 'low' } } },
  settings: { model: { available: [
    { ref: a, reasoning: { levels: [{ value: 'low' }, { value: 'max' }], defaultLevel: 'max' } },
    { ref: b, reasoning: { levels: [{ value: 'enabled' }], defaultLevel: 'enabled' } },
  ] } },
}
it('materializes the model default when the form leaves effort unset', () => {
  expect(resolveZcodeSelection(state, a)).toEqual({ ...a, options: { reasoningLevel: 'max' } })
  expect(resolveZcodeSelection(state, b)).toEqual({ ...b, options: { reasoningLevel: 'enabled' } })
})
it('keeps an explicit supported effort, including with the native default model', () => {
  expect(resolveZcodeSelection(state, { ...a, options: { reasoningLevel: 'low' } })?.options?.reasoningLevel).toBe('low')
  expect(resolveZcodeSelection(state, undefined, 'low')).toEqual({ ...a, options: { reasoningLevel: 'low' } })
})
it('rejects invalid or absent defaults instead of inventing a level or switching models', () => {
  expect(() => resolveZcodeSelection(state, a, 'medium')).toThrow('不支持')
  expect(() => resolveZcodeSelection(state, { providerId: 'gone', modelId: 'missing' })).toThrow('没有提供模型')
  const noDefault = { settings: { model: { available: [{ ref: a, reasoning: { levels: [{ value: 'low' }] } }] } } }
  expect(() => resolveZcodeSelection(noDefault, a)).toThrow('默认推理强度')
})
it('does not add a reasoning option to models without reasoning support', () => {
  expect(resolveZcodeSelection({ settings: { model: { available: [{ ref: b }] } } }, b)).toEqual(b)
})
