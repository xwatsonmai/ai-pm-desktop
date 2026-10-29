import type { ModelInfo, Result } from '../shared/api.js'
import type { Catalog } from './components/ModelPicker.js'

// Also bound lost/rejected IPC replies; a backend timeout alone cannot recover
// the UI when Electron never delivers that reply.
export async function readCatalog(request: () => Promise<Result<ModelInfo[]>>, timeoutMs = 65_000): Promise<Catalog> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      Promise.resolve().then(request),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('读取模型列表超时，请重新获取')), timeoutMs) }),
    ])
    if (!result.ok) return { models: null, error: result.message }
    if (!result.value.length) return { models: null, error: '没有读取到可用模型，请在对应应用登录并配置模型服务后点击“重新获取”' }
    return { models: result.value, error: null }
  } catch (error) {
    return { models: null, error: '读取模型列表失败：' + (error instanceof Error ? error.message : String(error)) }
  } finally { clearTimeout(timer) }
}
