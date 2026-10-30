import { spawn } from 'node:child_process'
import { resolveCodexBinary } from './codex-path.js'
import { commandLine } from './process.js'

export interface ModelInfo {
  id: string
  name: string
  efforts: string[]
  defaultEffort: string | null
  isDefault: boolean
}

// Asks the Codex CLI which models this login can use, over its app-server
// protocol (newline-delimited JSON-RPC on stdio). Read-only: no session is
// created and no model turn is spent.
export function listCodexModels(binary: string, timeoutMs = 20_000): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    const command = commandLine(resolveCodexBinary(binary), ['app-server'])
    const child = spawn(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: command.verbatim })
    const pending = new Map<number, (message: any) => void>()
    const models: ModelInfo[] = []
    let nextId = 1
    let buffer = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve(models)
    }
    const timer = setTimeout(() => finish(new Error('读取模型列表超时')), timeoutMs)
    const request = (method: string, params: object) => new Promise<any>((done) => {
      const id = nextId++
      pending.set(id, done)
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => finish(new Error(`codex app-server 退出（${code}）${stderr.trim() ? '：' + stderr.trim().slice(-200) : ''}`)))
    child.stdin.on('error', () => {}) // the process may already be gone; 'exit' reports why
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
          continue // not a protocol line
        }
        const done = pending.get(message.id)
        if (done) {
          pending.delete(message.id)
          done(message)
        }
      }
    })
    void (async () => {
      const init = await request('initialize', { clientInfo: { name: 'ai-pm-desktop', version: '0.1.0' } })
      if (init.error) throw new Error(init.error.message ?? 'initialize failed')
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
      const seen = new Set<string>()
      let cursor: string | null = null
      do {
        const page = await request('model/list', { includeHidden: false, cursor })
        if (page.error) throw new Error(page.error.message ?? 'model/list failed')
        for (const item of page.result?.data ?? []) {
          models.push({
            id: item.model ?? item.id, name: item.displayName ?? item.model ?? item.id,
            efforts: (item.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort).filter(Boolean),
            defaultEffort: item.defaultReasoningEffort ?? null, isDefault: !!item.isDefault,
          })
        }
        cursor = page.result?.nextCursor ?? null
        if (cursor && seen.has(cursor)) throw new Error('模型列表分页异常')
        if (cursor) seen.add(cursor)
      } while (cursor)
      finish(null)
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}
