import { existsSync, readFileSync } from 'node:fs'
import type { ExecutorSettings } from '../types.js'
import { resolveCodexBinary } from './codex-path.js'
import { readChunk, streamEvents } from './files.js'
import { killTree, liveness, runOnce } from './process.js'
import { startInteractive } from './interactive.js'
import { canMessage, sendRunMessage } from './run-messages.js'
import type { Executor, PollResult, RunSpec, StartedRun, TrackedRun } from './types.js'

// A detached app-server runner owns the native thread and active-turn steering.
export class CodexExecutor implements Executor {
  readonly name = 'codex' as const
  canMessage = canMessage
  sendMessage = sendRunMessage

  constructor(private readonly settings: () => ExecutorSettings) {}

  probe(): Promise<{ ok: boolean; detail: string }> {
    return runOnce(resolveCodexBinary(this.settings().binary), ['--version'], { timeoutMs: 10_000 })
      .then((detail) => ({ ok: true, detail }), (error: Error) => ({ ok: false, detail: error.message }))
  }

  start(spec: RunSpec): StartedRun {
    const settings = this.settings()
    const args: string[] = []
    if (spec.effort) args.push('-c', `model_reasoning_effort="${spec.effort}"`)
    for (const line of settings.configOverrides ?? []) if (line.trim()) args.push('-c', line.trim())
    args.push(...(settings.extraArgs ?? []))
    return startInteractive('codex', resolveCodexBinary(settings.binary), args, spec, settings.isolateUserConfig !== false)
  }

  poll(run: TrackedRun): PollResult {
    // Liveness first: a log read before it could miss lines a quick run wrote just before exiting.
    const alive = liveness(run.pid, run.pidStart) !== 'dead'
    const sessionId = run.sessionId ?? streamEvents(readChunk(run.logPath, false, 64 * 1024)).find((e) => e.type === 'thread.started')?.thread_id
    if (alive) return { done: false, sessionId }
    const tail = streamEvents(readChunk(run.logPath, true, 512 * 1024))
    const terminal = tail.findLast((e) => e.type === 'turn.completed' || e.type === 'turn.failed')
    if (terminal?.type === 'turn.completed' && existsSync(run.outPath)) {
      return { done: true, sessionId, outcome: { kind: 'completed', text: readFileSync(run.outPath, 'utf8') } }
    }
    const error = terminal?.error?.message ?? tail.findLast((e) => e.type === 'error')?.message
    if (terminal?.type === 'turn.failed') return { done: true, sessionId, outcome: { kind: 'failed', error } }
    const stderr = readChunk(run.logPath.replace(/events\.jsonl$/, 'stderr.log'), true, 2_000).trim()
    return { done: true, sessionId, outcome: { kind: 'interrupted', error: error ?? (stderr || 'process exited without a result') } }
  }

  kill(run: TrackedRun): Promise<void> {
    return killTree(run.pid)
  }
}
