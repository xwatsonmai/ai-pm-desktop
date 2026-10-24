// The contract between the Electron main process and the window. Types only.
import type { DevResult, ExecutorName, Kind, Settings, Stage, Status } from '../core/types.js'

export type { Settings, Stage, Status, DevResult }

export interface PlanQuestion {
  id: string
  title: string
  description: string
  kind: 'single_choice' | 'multiple_choice' | 'text'
  required: boolean
  options: { id: string; label: string; impact: string }[]
  recommended_option_ids: string[]
}

export interface PlanView {
  summary: string
  plan: string
  tests: string
  risks: string
  business_questions: PlanQuestion[]
  technical_findings: { topic: string; conclusion: string; evidence: string }[]
}

export interface TaskView {
  key: string
  kind: Kind
  platformId: string
  title: string
  stage: Stage
  status: Status
  reason: string | null
  detail: string | null
  executor: ExecutorName
  platformStatus: string | null
  branch: string | null
  worktree: string | null
  createdAt: string
  updatedAt: string
  failures: number
  lastError: string | null
  retryAt: number | null
  running: boolean
  plan: PlanView | null
  planAnswers: Record<string, string | string[]> | null
  dev: DevResult | null
  members: { key: string; title: string; platformId: string }[]
  batch: string | null
  release: Record<string, unknown> | null
  submittedSha: string | null
  takeover: { cwd: string; command: string } | null
}

export interface EngineView {
  running: boolean
  connected: boolean
  lastReconcileAt: string | null
  lastError: string | null
  bindingError: string | null
  authRequired: boolean
  contractError: string | null
  intakePaused: boolean
}

export interface Snapshot {
  configured: boolean
  engine: EngineView
  auth: { mode: 'oauth' | 'static'; loggedIn: boolean }
  executors: { name: ExecutorName; configured: boolean; healthy: boolean | null }[]
  tasks: TaskView[]
}

export interface RunView {
  id: string
  stage: Stage
  purpose: string
  executor: ExecutorName
  sessionId: string | null
  startedAt: string
  endedAt: string | null
  outcome: string | null
  error: string | null
}

export interface Detail {
  task: TaskView
  runs: RunView[]
  events: { at: string; type: string; message: string }[]
  outbox: { id: string; tool: string; status: string; attempts: number; lastError: string | null; createdAt: string }[]
}

export interface LogEntry {
  id: string // stable per item, so a started command is replaced when it completes
  kind: 'message' | 'command' | 'files' | 'reasoning' | 'status' | 'error' | 'other'
  text: string
  output?: string
  exitCode?: number | null
  running?: boolean
}

export interface LogChunk {
  entries: LogEntry[]
  offset: number
  done: boolean
}

export interface DiffView {
  base: string
  head: string
  stat: string
  patch: string
  truncated: boolean
}

export interface ProbeStep {
  step: string
  ok: boolean
  detail: string
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; code: string; message: string }

export type CommandName =
  | 'confirmPlan' | 'revisePlan' | 'answer' | 'requestChanges' | 'submitTest' | 'release' | 'continueRelease'
  | 'markReleased' | 'abandonBatch' | 'sendBackToDev' | 'retry' | 'takeOver' | 'handBack' | 'rework'
  | 'releaseClaim' | 'closeRequirement' | 'retryNow'

export interface Api {
  snapshot(): Promise<Snapshot>
  detail(key: string): Promise<Detail | null>
  runLog(runId: string, offset: number): Promise<LogChunk>
  diff(key: string): Promise<DiffView | null>
  command(name: CommandName, args: unknown[]): Promise<Result<unknown>>
  getSettings(): Promise<Settings | null>
  saveSettings(settings: Settings): Promise<Result>
  importLegacy(): Promise<Settings | null>
  detectCodex(): Promise<string | null>
  login(): Promise<Result>
  probe(): Promise<ProbeStep[]>
  setIntakePaused(paused: boolean): Promise<void>
  openPath(path: string): Promise<void>
  copy(text: string): Promise<void>
}

export type ApiMethod = keyof Api

export const API_METHODS: ApiMethod[] = [
  'snapshot', 'detail', 'runLog', 'diff', 'command', 'getSettings', 'saveSettings', 'importLegacy', 'detectCodex',
  'login', 'probe', 'setIntakePaused', 'openPath', 'copy',
]

export type Route = { page: 'needs' } | { page: 'tasks' } | { page: 'task'; key: string; tab?: string } | { page: 'settings' }
