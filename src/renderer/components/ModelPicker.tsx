import type { ModelInfo } from '../../shared/api.js'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export interface Catalog {
  models: ModelInfo[] | null // null while loading or when it could not be read
  error: string | null
}

type Choice = { model?: string; effort?: string }

// Model and reasoning effort, chosen from what the CLI itself reports. Falls
// back to typing the model ID when the list cannot be read.
export function ModelPicker({ catalog, value, onChange }: { catalog: Catalog; value: Choice; onChange: (next: Choice) => void }) {
  const { models, error } = catalog
  if (!models) {
    return (
      <div className="row">
        <input placeholder={error ? '模型 ID' : '读取模型列表…'} disabled={!error} value={value.model ?? ''} onChange={(e) => onChange({ ...value, model: e.target.value })} />
        <select disabled={!error} value={value.effort ?? ''} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
          <option value="">默认强度</option>
          {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
    )
  }
  const fallback = models.find((m) => m.isDefault)
  const chosen = models.find((m) => m.id === value.model)
  const target = chosen ?? (value.model ? undefined : fallback)
  const efforts = target?.efforts ?? EFFORTS
  return (
    <div className="row">
      <select value={value.model ?? ''} onChange={(e) => {
        const model = e.target.value || undefined
        const next = models.find((m) => m.id === model) ?? (model ? undefined : fallback)
        // An effort the new model does not offer would fail the run; fall back to its default.
        const effort = value.effort && next && !next.efforts.includes(value.effort) ? undefined : value.effort
        onChange({ model, effort })
      }}>
        <option value="">Codex 默认{fallback ? `（${fallback.name}）` : ''}</option>
        {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        {value.model && !chosen && <option value={value.model}>{value.model}（不在当前列表里）</option>}
      </select>
      <select value={value.effort ?? ''} onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}>
        <option value="">默认强度{target?.defaultEffort ? `（${target.defaultEffort}）` : ''}</option>
        {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
        {value.effort && !efforts.includes(value.effort) && <option value={value.effort}>{value.effort}（这个模型不支持）</option>}
      </select>
    </div>
  )
}
