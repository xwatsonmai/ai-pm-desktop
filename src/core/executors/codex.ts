import { execFile } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutorSettings } from '../types.js'
import { isAlive, killTree, spawnDetached } from './process.js'
import type { Executor, PollResult, RunSpec, StartedRun, TrackedRun } from './types.js'

function readChunk(path: string, fromEnd: boolean, size: number): string {
  if (!existsSync(path)) return ''
  const fd = openSync(path, 'r')
  try {
    const length = fstatSync(fd).size
    const start = fromEnd ? Math.max(0, length - size) : 0
    const buffer = Buffer.alloc(Math.min(size, length - start))
    readSync(fd, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function events(text: string): any[] {
  return text.split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return []
    try {
      return [JSON.parse(line)]
    } catch {
      return [] // A cut-off first line of a tail read.
    }
  })
}

// Drives `codex exec --json`. Each run is one detached process; `exec resume`
// continues the same session for later turns.
export class CodexExecutor implements Executor {
  readonly name = 'codex' as const

  constructor(private readonly settings: () => ExecutorSettings) {}

  probe(): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      execFile(this.settings().binary, ['--version'], { timeout: 10_000 }, (error, stdout) => {
        resolve(error ? { ok: false, detail: error.message } : { ok: true, detail: stdout.trim() })
      })
    })
  }

  start(spec: RunSpec): StartedRun {
    const settings = this.settings()
    mkdirSync(spec.dir, { recursive: true })
    const schemaPath = join(spec.dir, 'schema.json')
    const outPath = join(spec.dir, 'last-message.txt')
    const logPath = join(spec.dir, 'events.jsonl')
    writeFileSync(schemaPath, JSON.stringify(spec.schema))
    const args = ['exec']
    if (spec.sessionId) args.push('resume', spec.sessionId)
    args.push('--json', '--skip-git-repo-check', '--output-schema', schemaPath, '-o', outPath)
    if (!spec.sessionId) args.push('-C', spec.cwd)
    if (spec.model) args.push('-m', spec.model)
    if (spec.effort) args.push('-c', `model_reasoning_effort="${spec.effort}"`)
    if (spec.readOnly) args.push('-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"')
    else args.push('--dangerously-bypass-approvals-and-sandbox')
    args.push(...(settings.extraArgs ?? []), spec.prompt)
    const { pid, startToken } = spawnDetached(settings.binary, args, {
      cwd: spec.cwd,
      logPath,
      errPath: join(spec.dir, 'stderr.log'),
    })
    return { pid, pidStart: startToken, logPath, outPath }
  }

  poll(run: TrackedRun): PollResult {
    const sessionId = run.sessionId ?? events(readChunk(run.logPath, false, 64 * 1024)).find((e) => e.type === 'thread.started')?.thread_id
    if (isAlive(run.pid, run.pidStart)) return { done: false, sessionId }
    const tail = events(readChunk(run.logPath, true, 512 * 1024))
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
