export interface ZcodeSelection {
  providerId: string
  modelId: string
  options?: { reasoningLevel?: string }
}

export function resolveZcodeSelection(state: any, requested?: ZcodeSelection, effort?: string): ZcodeSelection | undefined {
  const current: ZcodeSelection | undefined = state.session?.model ?? state.settings?.model?.current
  const selected = requested ?? current
  if (!selected) return undefined
  const offered = state.settings?.model?.available?.find((m: any) => m.ref.providerId === selected.providerId && m.ref.modelId === selected.modelId)
  if (!offered) throw new Error(`ZCode 当前没有提供模型 ${selected.providerId}/${selected.modelId}，请重新获取模型后重试`)
  const levels: string[] = (offered.reasoning?.levels ?? []).map((l: any) => l.value)
  const explicit = effort ?? requested?.options?.reasoningLevel
  if (explicit && !levels.includes(explicit)) throw new Error(`ZCode 模型不支持推理强度 ${explicit}，请重新选择强度后重试`)
  const sameCurrent = current?.providerId === selected.providerId && current?.modelId === selected.modelId
  const level = explicit ?? offered.reasoning?.defaultLevel ?? (sameCurrent ? current?.options?.reasoningLevel : undefined)
  if (levels.length && (!level || !levels.includes(level))) throw new Error('ZCode 未返回有效的默认推理强度，请在客户端配置中选择强度后重试')
  return { ...selected, ...(level ? { options: { ...selected.options, reasoningLevel: level } } : {}) }
}
