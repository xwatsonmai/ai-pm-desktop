// Shared vocabulary of the v2 client. See the design doc, "单一状态机".

export type Kind = 'task' | 'collaboration' | 'batch'
export type Stage = 'plan' | 'develop' | 'review' | 'test_release' | 'release' | 'collab'
export type Status = 'queued' | 'running' | 'needs_you' | 'waiting' | 'done' | 'closed'

export type NeedsReason =
  | 'plan_confirm'
  | 'agent_question'
  | 'ready_to_test'
  | 'ready_to_release'
  | 'release_failed'
  | 'output_invalid'
  | 'executor_failing'
  | 'platform_rejected'
  | 'taken_over'

// syncing: a platform write for this task is in the outbox.
// in_batch: a release batch that contains this task is in progress.
export type WaitReason = 'syncing' | 'aligning' | 'testing' | 'acceptance' | 'in_batch'

export type ExecutorName = 'codex' | 'claude' | 'zcode'

// start: first turn of a new session. The other purposes continue an existing one.
export type RunPurpose = 'start' | 'continue' | 'repair' | 'resume' | 'alignment'

export interface ModelChoice {
  model?: string
  effort?: string
}

export interface NextRun {
  purpose: RunPurpose
  message?: string
  schema?: 'plan' | 'develop' | 'alignment' | 'release' | 'collab'
}

export interface TaskData {
  next?: NextRun
  context?: unknown // trimmed platform context, written to .ai-pm/task.json
  plan?: Record<string, unknown> | null
  planRevision?: number | null
  planApproval?: { plan: unknown; answers: unknown; revision: number | null; at: string } | null
  dev?: DevResult | null
  feedback?: { at: string; source: string; text: string }[]
  interruptions?: number
  repairs?: number
  revisionChanged?: boolean
  claiming?: boolean
  batch?: string | null // key of the batch this task belongs to
  members?: string[] // batch only
  release?: Record<string, unknown> | null // batch result
  submittedSha?: string | null
  rejected?: { outboxId: string; tool: string; error: string } | null
  takenOver?: { stage: Stage; status: Status } | null
  lastReportAt?: number
}

export interface DevResult {
  status: 'done' | 'needs_alignment' | 'needs_user' | 'blocked'
  summary: string
  sha: string
  tests: string
  limitations: string
  message: string
  alignment_questions: { title: string; detail: string }[]
}

export interface Task {
  key: string
  kind: Kind
  platformId: string
  title: string
  stage: Stage
  status: Status
  reason: NeedsReason | WaitReason | null
  detail: string | null
  executor: ExecutorName
  models: { expert?: ModelChoice; execution?: ModelChoice }
  claimId: string | null
  revision: number | null
  version: number | null
  platformStatus: string | null
  branch: string | null
  worktree: string | null
  sessions: Partial<Record<Stage, string>>
  data: TaskData
  retryAt: number | null
  failures: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface ExecutorSettings {
  binary: string
  limit: number
  extraArgs?: string[]
  models?: { expert?: ModelChoice; execution?: ModelChoice }
}

export interface Settings {
  projectId: string
  mcpUrl: string
  resourceUri: string
  protocolVersion?: string
  repository: string // platform repository URL, checked against repoPath's origin
  repoPath: string
  startRef: string
  executors: Partial<Record<ExecutorName, ExecutorSettings>>
  allowedExecutors: ExecutorName[]
  testReleaseInstructions: string
  releaseInstructions: string
  maxOpenTasks: number
  intakePaused?: boolean
  timing?: Partial<Timing>
}

export interface Timing {
  tickMs: number
  pollActiveMs: number
  pollIdleMs: number
  backoffMs: number[]
  reconnectMs: number[]
  collabReportMs: number
  callTimeoutMs: number
  bindingCheckMs: number
  probeMs: number
}

export const DEFAULT_TIMING: Timing = {
  tickMs: 2_000,
  pollActiveMs: 5 * 60_000,
  pollIdleMs: 15 * 60_000,
  backoffMs: [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000],
  reconnectMs: [1_000, 2_000, 5_000, 10_000, 30_000, 60_000],
  collabReportMs: 180_000,
  callTimeoutMs: 30_000,
  bindingCheckMs: 10 * 60_000,
  probeMs: 10 * 60_000,
}

export const TERMINAL: Status[] = ['done', 'closed']
