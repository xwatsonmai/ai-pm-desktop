import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutorSettings } from '../types.js'
import type { ModelInfo } from './codex-models.js'
import { zcodeCommand } from './zcode.js'

// Asks ZCode which models its login and providers offer. A new session reports
// them with their reasoning levels; it is closed again without sending anything,
// so no model call is spent.
export function listZcodeModels(settings: ExecutorSettings, timeoutMs = 60_000): Promise<ModelInfo[]> {
  const { command, env } = zcodeCommand(settings)
  const workspace = mkdtempSync(join(tmpdir(), 'ai-pm-zcode-models-'))
  return new Promise<ModelInfo[]>((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), 'app-server', '--stdio'], {
      cwd: workspace, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    const pending = new Map<number, (message: any) => void>()
    let nextId = 0
    let buffer = ''
    let stderr = ''
    let settled = false
    child.once('close', () => {
      // Windows may briefly retain locks after exit. Cleanup must never block
      // settling the IPC request, even when retries ultimately fail.
      void rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    })
    const finish = (error: Error | null, models: ModelInfo[] = []) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(models)
      child.kill()
    }
    const timer = setTimeout(() => finish(new Error('读取模型列表超时')), timeoutMs)
    const call = (method: string, params: object) => new Promise<any>((done) => {
      const id = ++nextId
      pending.set(id, done)
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => finish(new Error(`ZCode app-server 退出（${code}）${stderr.trim() ? '：' + stderr.trim().slice(-200) : ''}`)))
    child.stdin.on('error', () => {})
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id != null && message.method) {
          const result = { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false }
          child.stdin.write(JSON.stringify(message.method === 'session/requestRuntimePreferences' ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: 'unsupported' } }) + '\n')
        } else if (message.id != null) {
          pending.get(message.id)?.(message)
          pending.delete(message.id)
        }
      }
    })
    void (async () => {
      const created = await call('session/create', { workspace: { workspacePath: workspace, workspaceKey: workspace }, mcpServers: [], mode: 'plan', titleGenerationEnabled: false })
      if (created.error) throw new Error(created.error.message ?? 'session/create failed')
      const { session, settings: offered } = created.result
      const current = session?.model ?? offered?.model?.current ?? {}
      const models: ModelInfo[] = (offered?.model?.available ?? []).map((m: any) => ({
        id: `${m.ref.providerId}::${m.ref.modelId}`,
        name: m.providerLabel ? `${m.label}（${m.providerLabel}）` : m.label,
        efforts: (m.reasoning?.levels ?? []).map((l: any) => l.value).filter(Boolean),
        defaultEffort: m.reasoning?.defaultLevel ?? null,
        isDefault: m.ref.providerId === current.providerId && m.ref.modelId === current.modelId,
      }))
      await call('session/close', { sessionId: session.sessionId })
      finish(null, models)
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}
