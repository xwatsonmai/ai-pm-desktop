import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutorSettings } from '../types.js'
import { readChunk, streamEvents } from './files.js'
import { killTree, liveness, runOnce, spawnDetached } from './process.js'
import type { Executor, PollResult, RunSpec, StartedRun, TrackedRun } from './types.js'

// Drives `codex exec --json`. Each run is one detached process; `exec resume`
// continues the same session for later turns.
export class CodexExecutor implements Executor {
  readonly name = 'codex' as const

  constructor(private readonly settings: () => ExecutorSettings) {}

  probe(): Promise<{ ok: boolean; detail: string }> {
    return runOnce(this.settings().binary, ['--version'], { timeoutMs: 10_000 })
      .then((detail) => ({ ok: true, detail }), (error: Error) => ({ ok: false, detail: error.message }))
  }

  start(spec: RunSpec): StartedRun {
    const settings = this.settings()
    mkdirSync(spec.dir, { recursive: true })
    const schemaPath = join(spec.dir, 'schema.json')
    const outPath = join(spec.dir, 'last-message.txt')
    const logPath = join(spec.dir, 'events.jsonl')
    const promptPath = join(spec.dir, 'prompt.txt')
    writeFileSync(schemaPath, JSON.stringify(spec.schema))
    writeFileSync(promptPath, spec.prompt)
    const args = ['exec']
    if (spec.sessionId) args.push('resume', spec.sessionId)
    args.push('--json', '--skip-git-repo-check', '--output-schema', schemaPath, '-o', outPath)
    if (settings.isolateUserConfig !== false) args.push('--ignore-user-config')
    if (!spec.sessionId) args.push('-C', spec.cwd)
    if (spec.model) args.push('-m', spec.model)
    if (spec.effort) args.push('-c', `model_reasoning_effort="${spec.effort}"`)
    if (spec.readOnly) args.push('-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"')
    else args.push('--dangerously-bypass-approvals-and-sandbox')
    for (const line of settings.configOverrides ?? []) if (line.trim()) args.push('-c', line.trim())
    // `-`: the prompt comes on stdin, which carries any length and line breaks on every platform.
    args.push(...(settings.extraArgs ?? []), '-')
    const { pid, startToken } = spawnDetached(settings.binary, args, {
      cwd: spec.cwd,
      logPath,
      errPath: join(spec.dir, 'stderr.log'),
      stdinPath: promptPath,
    })
    return { pid, pidStart: startToken, logPath, outPath }
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
