import type { ModelInfo } from '../core/executors/codex-models.js'
import type { BindingMetadata } from '../core/platform/binding.js'
export type { BindingMetadata }
export interface ProjectBinding extends BindingMetadata { ticket?: string }
// The contract between the Electron main process and the window. Types only.
import type { DevResult, ExecutorName, GlobalSettings, Kind, ProjectSettings, ReviewRound, Settings, Stage, Status } from '../core/types.js'

export type { Settings, Stage, Status, DevResult, GlobalSettings, ProjectSettings }

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
  syncIssue?: { failures: number; message: string; at: string } | null
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
  project: string // local id of the project it belongs to
  takeover: { cwd: string; command: string } | null
  reviewer: ExecutorName | null // executor of the current review
  reviews: ReviewRound[]
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

// One project the client serves: its own platform login, connection and tasks.
export interface ProjectView {
  id: string // local id
  projectId: string // the platform's project id
  name: string // the platform's name for it, or its id until connected
  engine: EngineView
  auth: { mode: 'oauth' | 'static'; loggedIn: boolean; lastError?: string | null }
}

export interface Snapshot {
  configured: boolean // at least one project is set up
  projects: ProjectView[]
  executors: { name: ExecutorName; configured: boolean; healthy: boolean | null; expertModel: string | null }[]
  tasks: TaskView[]
}

// Machine-wide settings, and each project's own.
export interface AppSettings {
  globals: GlobalSettings
  projects: { id: string; settings: ProjectSettings }[]
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

// What the platform says the work is: the confirmed requirement text, its
// acceptance criteria and what review settled, for reading next to the plan.
export interface RequirementView {
  title: string
  kind: string
  revision: number | null
  description: string
  acceptance: string[]
  decisions: { title: string; conclusion: string }[]
  original: string | null // what the product first wrote, when review rewrote it
  parent: { description: string; acceptance: string[] } | null // a linked bug's requirement
}

// A local checkout of the task: its own, or one a release made for it alone.
export interface WorkspaceView {
  label: string
  path: string
  exists: boolean
  changes: string[] | null // uncommitted paths; null while an agent is working in it
  removeAt: string | null // when cleanup will delete it, for a finished task
}

export interface Detail {
  task: TaskView
  requirement: RequirementView | null
  workspaces: WorkspaceView[]
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
  // How it combines with an earlier entry of the same id: replace it (default),
  // add to its text (streamed output) or fill in fields (a finished tool call).
  merge?: 'append' | 'patch'
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
  | 'releaseClaim' | 'closeRequirement' | 'retryNow' | 'removeWorkspace' | 'startReview' | 'applyReview' | 'rereview' | 'skipReview'

export type { ModelInfo }

export interface Api {
  snapshot(): Promise<Snapshot>
  detail(key: string): Promise<Detail | null>
  runLog(runId: string, offset: number): Promise<LogChunk>
  diff(key: string): Promise<DiffView | null>
  command(name: CommandName, args: unknown[]): Promise<Result<unknown>>
  getSettings(): Promise<AppSettings>
  saveGlobals(globals: GlobalSettings): Promise<Result>
  saveProject(id: string | null, settings: ProjectSettings, ticket?: string): Promise<Result<string>> // returns the project's id
  discoverProject(entry: string, existingId?: string): Promise<Result<ProjectBinding>>
  cancelProjectBinding(ticket: string): Promise<void>
  checkRepository(settings: Pick<ProjectSettings, 'repoPath' | 'repository' | 'startRef'>): Promise<Result<{ root: string; branch: string }>>
  chooseRepository(): Promise<string | null>
  removeProject(id: string): Promise<Result>
  importLegacy(): Promise<{ project: ProjectSettings; globals: GlobalSettings } | null>
  detectExecutor(name: ExecutorName): Promise<{ binary: string; runtime?: string } | null>
  login(project: string): Promise<Result>
  probe(project: string): Promise<ProbeStep[]>
  setIntakePaused(project: string | null, paused: boolean): Promise<void> // null: every project
  openPath(path: string): Promise<void>
  copy(text: string): Promise<void>
  launchAtLogin(): Promise<boolean>
  setLaunchAtLogin(on: boolean): Promise<void>
  listModels(executor: ExecutorName, config: { binary: string; runtime?: string }): Promise<Result<ModelInfo[]>>
}

export type ApiMethod = keyof Api

export const API_METHODS: ApiMethod[] = [
  'snapshot', 'detail', 'runLog', 'diff', 'command', 'getSettings', 'saveGlobals', 'saveProject', 'discoverProject', 'cancelProjectBinding', 'checkRepository', 'chooseRepository', 'removeProject', 'importLegacy', 'detectExecutor',
  'login', 'probe', 'setIntakePaused', 'openPath', 'copy', 'launchAtLogin', 'setLaunchAtLogin', 'listModels',
]

export type Route = { page: 'needs' } | { page: 'tasks' } | { page: 'task'; key: string; tab?: string } | { page: 'settings' }
