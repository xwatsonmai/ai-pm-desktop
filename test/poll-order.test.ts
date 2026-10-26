import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The agent writes its whole log and exits while the client is checking
// whether it is still alive: a quick run, or a slow `ps` under load.
let finishDuringCheck: () => void = () => {}
vi.mock('../src/core/executors/process.js', async (original) => ({
  ...(await original<typeof import('../src/core/executors/process.js')>()),
  liveness: () => {
    finishDuringCheck()
    return 'dead'
  },
}))

const { CodexExecutor } = await import('../src/core/executors/codex.js')
const { ClaudeExecutor } = await import('../src/core/executors/claude.js')
const { ZCodeExecutor } = await import('../src/core/executors/zcode.js')

const cases = [
  { name: 'codex', executor: new CodexExecutor(() => ({ binary: 'codex', limit: 1 })), lines: [{ type: 'thread.started', thread_id: 's1' }, { type: 'turn.completed' }], out: '{}' },
  { name: 'claude', executor: new ClaudeExecutor(() => ({ binary: 'claude', limit: 1 })), lines: [{ type: 'system', subtype: 'init', session_id: 's1' }, { type: 'result', subtype: 'success', is_error: false, structured_output: {} }] },
  { name: 'zcode', executor: new ZCodeExecutor(() => ({ binary: 'zcode', limit: 1 })), lines: [{ type: 'zcode.session', sessionId: 's1' }, { type: 'zcode.result', status: 'completed' }], out: '{}' },
]

describe('reading a run that ends while it is checked', () => {
  it.each(cases)('$name keeps the session id of a run that finished during the check', ({ executor, lines, out }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-pm-poll-'))
    const run = { pid: 1, pidStart: null, logPath: join(dir, 'events.jsonl'), outPath: join(dir, 'last-message.txt'), sessionId: null }
    writeFileSync(run.logPath, '')
    finishDuringCheck = () => {
      writeFileSync(run.logPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
      if (out) writeFileSync(run.outPath, out)
    }
    const result = executor.poll(run)
    expect(result).toMatchObject({ done: true, sessionId: 's1', outcome: { kind: 'completed' } })
  })
})
