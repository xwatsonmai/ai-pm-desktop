import type { ExecutorName } from '../types.js'

export interface RunSpec {
  dir: string // private directory for this run's schema, log and output files
  cwd: string
  prompt: string
  schema: object
  sessionId?: string // continue this session; start a new one when absent
  model?: string
  effort?: string
  readOnly: boolean
}

export interface StartedRun {
  pid: number
  pidStart: string | null
  logPath: string
  outPath: string
}

export interface RunOutcome {
  kind: 'completed' | 'failed' | 'interrupted'
  text?: string
  error?: string
}

export interface TrackedRun {
  pid: number
  pidStart: string | null
  logPath: string
  outPath: string
  sessionId: string | null
}

export type PollResult = { done: false; sessionId?: string } | { done: true; sessionId?: string; outcome: RunOutcome }

export interface Executor {
  readonly name: ExecutorName
  probe(): Promise<{ ok: boolean; detail: string }>
  start(spec: RunSpec): StartedRun
  // Pure inspection of the process and its files, so it works after a client restart.
  poll(run: TrackedRun): PollResult
  kill(run: TrackedRun): Promise<void>
}
