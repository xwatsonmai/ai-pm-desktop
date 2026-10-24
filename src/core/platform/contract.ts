import { PlatformError, type Platform } from './client.js'

// No task has this id; asking for it is a read that must fail.
export const CONTRACT_PROBE_TASK = 'tsk_ai_pm_client_contract_check'

// The client resends a write only when the platform marks the error retryable,
// and tells a refusal apart from a conflict by its code. A platform older than
// its idempotency release answers with plain text, and the client could not
// recover on its own. Returns null when the platform speaks the contract, or
// the problem. Throws when it cannot tell right now (offline, signed out).
export async function contractProblem(platform: Platform): Promise<string | null> {
  try {
    await platform.call('task_get_context', { task_id: CONTRACT_PROBE_TASK })
  } catch (error) {
    if (!(error instanceof PlatformError)) throw error
    if (error.code === 'not_found') return null
    if (error.kind === 'auth' || error.kind === 'retryable') throw error
    return `平台没有返回结构化错误码，需要先部署平台的幂等改造版本（${error.code ?? '无错误码'}：${error.message}）`
  }
  return '平台返回了一个本不存在的任务，无法确认错误码'
}
