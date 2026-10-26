import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutorSettings } from '../types.js'
import { readChunk, streamEvents } from './files.js'
import { killTree, liveness, runOnce, spawnDetached } from './process.js'
import type { Executor, PollResult, RunSpec, StartedRun, TrackedRun } from './types.js'

// Read-only runs may look around but not change anything. Claude Code has no
// OS sandbox in print mode, so this is an allowlist of tools and read-only commands.
const READ_ONLY_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS', 'TodoWrite',
  ...['git log', 'git show', 'git diff', 'git status', 'git branch', 'git ls-files', 'git grep', 'git blame', 'git rev-parse',
    'rg', 'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'tree'].map((command) => `Bash(${command}:*)`),
]

// Drives `claude -p --output-format stream-json`. Each run is one detached
// process; the session id is chosen up front and `--resume` continues it.
export class ClaudeExecutor implements Executor {
  readonly name = 'claude' as const

  constructor(private readonly settings: () => ExecutorSettings) {}

  probe(): Promise<{ ok: boolean; detail: string }> {
    return runOnce(this.settings().binary, ['--version'], { timeoutMs: 10_000 })
      .then((detail) => ({ ok: true, detail }), (error: Error) => ({ ok: false, detail: error.message }))
  }

  start(spec: RunSpec): StartedRun {
    const settings = this.settings()
    mkdirSync(spec.dir, { recursive: true })
    const logPath = join(spec.dir, 'events.jsonl')
    const promptPath = join(spec.dir, 'prompt.txt')
    writeFileSync(promptPath, spec.prompt)
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(spec.schema)]
    if (spec.sessionId) args.push('--resume', spec.sessionId)
    else args.push('--session-id', randomUUID())
    // The user's own settings and MCP servers stay out (they may include the AI PM platform).
    if (settings.isolateUserConfig !== false) args.push('--setting-sources', 'project,local', '--strict-mcp-config')
    if (settings.mcpConfig?.trim()) args.push('--mcp-config', settings.mcpConfig.trim())
    if (spec.model) args.push('--model', spec.model)
    if (spec.effort) args.push('--effort', spec.effort)
    if (spec.readOnly) args.push('--permission-mode', 'dontAsk', '--allowedTools', ...READ_ONLY_TOOLS)
    else args.push('--permission-mode', 'bypassPermissions')
    // No prompt argument: print mode reads it from stdin, which carries any length and line breaks.
    args.push(...(settings.extraArgs ?? []))
    const { pid, startToken } = spawnDetached(settings.binary, args, {
      cwd: spec.cwd,
      logPath,
      errPath: join(spec.dir, 'stderr.log'),
      stdinPath: promptPath,
    })
    return { pid, pidStart: startToken, logPath, outPath: logPath }
  }

  poll(run: TrackedRun): PollResult {
    // Liveness first: a log read before it could miss lines a quick run wrote just before exiting.
    const alive = liveness(run.pid, run.pidStart) !== 'dead'
    const sessionId = run.sessionId ?? streamEvents(readChunk(run.logPath, false, 64 * 1024)).find((e) => e.session_id)?.session_id
    if (alive) return { done: false, sessionId }
    const result = streamEvents(readChunk(run.logPath, true, 512 * 1024)).findLast((e) => e.type === 'result')
    if (result && !result.is_error && result.subtype === 'success') {
      const text = result.structured_output !== undefined ? JSON.stringify(result.structured_output) : String(result.result ?? '')
      return { done: true, sessionId, outcome: { kind: 'completed', text } }
    }
    if (result) return { done: true, sessionId, outcome: { kind: 'failed', error: String(result.result || result.subtype || 'failed') } }
    const stderr = readChunk(join(run.logPath, '..', 'stderr.log'), true, 2_000).trim()
    return { done: true, sessionId, outcome: { kind: 'interrupted', error: stderr || 'process exited without a result' } }
  }

  kill(run: TrackedRun): Promise<void> {
    return killTree(run.pid)
  }
}
