import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SchemaName } from './flows/schemas.js'
import type { ExecutorName, Kind, NeedsReason, RunPurpose, Settings, Stage, Status, Task, WaitReason } from './types.js'

// Secrets never reach logs or prompts. Electron seals them with safeStorage;
// tests and the CLI use the plain implementation.
export interface Secrets {
  seal(value: string): string
  open(value: string): string
}

export const plainSecrets: Secrets = {
  seal: (value) => 'plain:' + value,
  open: (value) => value.replace(/^plain:/, ''),
}

export interface RunRow {
  id: string
  taskKey: string
  stage: Stage
  purpose: RunPurpose
  schemaName: SchemaName
  executor: ExecutorName
  sessionId: string | null
  pid: number
  pidStart: string | null
  logPath: string
  outPath: string
  startedAt: string
  endedAt: string | null
  outcome: 'completed' | 'failed' | 'interrupted' | null
  result: string | null
  error: string | null
}

export interface OutboxRow {
  id: string // also the platform request_id
  taskKey: string
  tool: string
  params: Record<string, unknown>
  status: 'pending' | 'done' | 'rejected'
  attempts: number
  nextAt: number
  lastError: string | null
  effect: string
  effectArgs: Record<string, unknown>
  result: unknown
  createdAt: string
}

export interface EventRow {
  id: number
  at: string
  taskKey: string | null
  type: string
  message: string
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (
     key TEXT PRIMARY KEY, kind TEXT NOT NULL, platform_id TEXT NOT NULL, title TEXT NOT NULL,
     stage TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, detail TEXT, executor TEXT NOT NULL,
     claim_secret TEXT, revision INTEGER, version INTEGER, platform_status TEXT,
     branch TEXT, worktree TEXT, doc TEXT NOT NULL,
     retry_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status)`,
  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY, task_key TEXT NOT NULL, stage TEXT NOT NULL, purpose TEXT NOT NULL,
     schema_name TEXT NOT NULL, executor TEXT NOT NULL, session_id TEXT, pid INTEGER NOT NULL, pid_start TEXT,
     log_path TEXT NOT NULL, out_path TEXT NOT NULL, started_at TEXT NOT NULL,
     ended_at TEXT, outcome TEXT, result TEXT, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS runs_open ON runs(ended_at)`,
  `CREATE TABLE IF NOT EXISTS outbox (
     id TEXT PRIMARY KEY, task_key TEXT NOT NULL, tool TEXT NOT NULL, params TEXT NOT NULL,
     status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
     last_error TEXT, effect TEXT NOT NULL, effect_args TEXT NOT NULL, result TEXT,
     seq INTEGER NOT NULL, created_at TEXT NOT NULL, done_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, seq)`,
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, task_key TEXT,
     type TEXT NOT NULL, message TEXT NOT NULL)`,
]

export const now = () => new Date().toISOString()

interface TaskDoc {
  models: Task['models']
  sessions: Task['sessions']
  data: Task['data']
}

export class Store {
  readonly db: DatabaseSync
  private seq = 0

  constructor(path: string, readonly secrets: Secrets = plainSecrets) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    // Tokens and claim credentials live here; keep the file private to the user.
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL')
    for (const statement of SCHEMA) this.db.exec(statement)
    const row = this.db.prepare('SELECT MAX(seq) AS seq FROM outbox').get() as { seq: number | null }
    this.seq = row.seq ?? 0
  }

  close() {
    this.db.close()
  }

  // Runs fn atomically. Nested calls join the outer transaction.
  private depth = 0
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth--
    }
  }

  // ---- settings ----

  getSettings(): Settings | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'settings'`).get() as { value: string } | undefined
    return row ? (JSON.parse(row.value) as Settings) : null
  }

  setSettings(settings: Settings) {
    this.db.prepare(`INSERT INTO settings(key, value) VALUES('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(settings))
  }

  getSecret(name: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('secret:' + name) as { value: string } | undefined
    return row ? this.secrets.open(row.value) : null
  }

  setSecret(name: string, value: string) {
    this.db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run('secret:' + name, this.secrets.seal(value))
  }

  // ---- tasks ----

  private toTask(row: Record<string, any>): Task {
    const doc = JSON.parse(row.doc) as TaskDoc
    return {
      key: row.key, kind: row.kind as Kind, platformId: row.platform_id, title: row.title,
      stage: row.stage as Stage, status: row.status as Status, reason: row.reason as NeedsReason | WaitReason | null,
      detail: row.detail, executor: row.executor as ExecutorName, models: doc.models ?? {},
      claimId: row.claim_secret ? this.secrets.open(row.claim_secret) : null,
      revision: row.revision, version: row.version, platformStatus: row.platform_status,
      branch: row.branch, worktree: row.worktree, sessions: doc.sessions ?? {}, data: doc.data ?? {},
      retryAt: row.retry_at, failures: row.failures, lastError: row.last_error,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  getTask(key: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE key = ?').get(key) as Record<string, any> | undefined
    return row ? this.toTask(row) : null
  }

  listTasks(where: { status?: Status[]; kind?: Kind[] } = {}): Task[] {
    const clauses: string[] = []
    const args: string[] = []
    if (where.status) {
      clauses.push(`status IN (${where.status.map(() => '?').join(',')})`)
      args.push(...where.status)
    }
    if (where.kind) {
      clauses.push(`kind IN (${where.kind.map(() => '?').join(',')})`)
      args.push(...where.kind)
    }
    const sql = 'SELECT * FROM tasks' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') + ' ORDER BY updated_at, key'
    return (this.db.prepare(sql).all(...args) as Record<string, any>[]).map((row) => this.toTask(row))
  }

  saveTask(task: Task) {
    task.updatedAt = now()
    const doc: TaskDoc = { models: task.models, sessions: task.sessions, data: task.data }
    this.db.prepare(`INSERT INTO tasks(key, kind, platform_id, title, stage, status, reason, detail, executor,
        claim_secret, revision, version, platform_status, branch, worktree, doc, retry_at, failures, last_error,
        created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, platform_id=excluded.platform_id, title=excluded.title,
        stage=excluded.stage, status=excluded.status, reason=excluded.reason, detail=excluded.detail,
        executor=excluded.executor, claim_secret=excluded.claim_secret, revision=excluded.revision,
        version=excluded.version, platform_status=excluded.platform_status, branch=excluded.branch,
        worktree=excluded.worktree, doc=excluded.doc, retry_at=excluded.retry_at, failures=excluded.failures,
        last_error=excluded.last_error, updated_at=excluded.updated_at`)
      .run(task.key, task.kind, task.platformId, task.title, task.stage, task.status, task.reason, task.detail,
        task.executor, task.claimId ? this.secrets.seal(task.claimId) : null, task.revision, task.version,
        task.platformStatus, task.branch, task.worktree, JSON.stringify(doc), task.retryAt, task.failures,
        task.lastError, task.createdAt, task.updatedAt)
  }

  // Read-modify-write of one task inside a transaction. Returns the saved task.
  updateTask(key: string, fn: (task: Task) => void): Task {
    return this.tx(() => {
      const task = this.getTask(key)
      if (!task) throw new Error('task_not_found: ' + key)
      fn(task)
      this.saveTask(task)
      return task
    })
  }

  // ---- runs ----

  insertRun(run: Omit<RunRow, 'endedAt' | 'outcome' | 'result' | 'error'>) {
    this.db.prepare(`INSERT INTO runs(id, task_key, stage, purpose, schema_name, executor, session_id, pid, pid_start,
        log_path, out_path, started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(run.id, run.taskKey, run.stage, run.purpose, run.schemaName, run.executor, run.sessionId, run.pid,
        run.pidStart, run.logPath, run.outPath, run.startedAt)
  }

  private toRun(row: Record<string, any>): RunRow {
    return {
      id: row.id, taskKey: row.task_key, stage: row.stage, purpose: row.purpose, schemaName: row.schema_name, executor: row.executor,
      sessionId: row.session_id, pid: row.pid, pidStart: row.pid_start, logPath: row.log_path,
      outPath: row.out_path, startedAt: row.started_at, endedAt: row.ended_at, outcome: row.outcome,
      result: row.result, error: row.error,
    }
  }

  openRuns(): RunRow[] {
    return (this.db.prepare('SELECT * FROM runs WHERE ended_at IS NULL ORDER BY started_at').all() as Record<string, any>[])
      .map((row) => this.toRun(row))
  }

  runsFor(taskKey: string): RunRow[] {
    return (this.db.prepare('SELECT * FROM runs WHERE task_key = ? ORDER BY started_at').all(taskKey) as Record<string, any>[])
      .map((row) => this.toRun(row))
  }

  setRunSession(id: string, sessionId: string) {
    this.db.prepare('UPDATE runs SET session_id = ? WHERE id = ?').run(sessionId, id)
  }

  endRun(id: string, outcome: RunRow['outcome'], result: string | null, error: string | null) {
    this.db.prepare('UPDATE runs SET ended_at = ?, outcome = ?, result = ?, error = ? WHERE id = ? AND ended_at IS NULL')
      .run(now(), outcome, result, error, id)
  }

  // ---- outbox ----

  enqueue(item: { taskKey: string; tool: string; params: Record<string, unknown>; effect: string; effectArgs?: Record<string, unknown> }): string {
    const id = randomUUID()
    const params = { ...item.params, request_id: id }
    this.seq += 1
    this.db.prepare(`INSERT INTO outbox(id, task_key, tool, params, status, attempts, next_at, effect, effect_args, seq, created_at)
        VALUES(?,?,?,?, 'pending', 0, 0, ?,?,?,?)`)
      .run(id, item.taskKey, item.tool, JSON.stringify(params), item.effect, JSON.stringify(item.effectArgs ?? {}), this.seq, now())
    return id
  }

  private toOutbox(row: Record<string, any>): OutboxRow {
    return {
      id: row.id, taskKey: row.task_key, tool: row.tool, params: JSON.parse(row.params), status: row.status,
      attempts: row.attempts, nextAt: row.next_at, lastError: row.last_error, effect: row.effect,
      effectArgs: JSON.parse(row.effect_args), result: row.result ? JSON.parse(row.result) : null,
      createdAt: row.created_at,
    }
  }

  // Pending items in send order. A task's later writes wait for its earlier ones.
  pendingOutbox(): OutboxRow[] {
    return (this.db.prepare(`SELECT * FROM outbox WHERE status = 'pending' ORDER BY seq`).all() as Record<string, any>[])
      .map((row) => this.toOutbox(row))
  }

  getOutbox(id: string): OutboxRow | null {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as Record<string, any> | undefined
    return row ? this.toOutbox(row) : null
  }

  outboxFor(taskKey: string): OutboxRow[] {
    return (this.db.prepare('SELECT * FROM outbox WHERE task_key = ? ORDER BY seq').all(taskKey) as Record<string, any>[])
      .map((row) => this.toOutbox(row))
  }

  outboxDone(id: string, result: unknown) {
    this.db.prepare(`UPDATE outbox SET status = 'done', result = ?, done_at = ?, attempts = attempts + 1 WHERE id = ?`)
      .run(JSON.stringify(result ?? null), now(), id)
  }

  outboxRetry(id: string, nextAt: number, error: string) {
    this.db.prepare('UPDATE outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?').run(nextAt, error, id)
  }

  outboxRejected(id: string, error: string) {
    this.db.prepare(`UPDATE outbox SET status = 'rejected', attempts = attempts + 1, last_error = ?, done_at = ? WHERE id = ?`)
      .run(error, now(), id)
  }

  // ---- events ----

  event(taskKey: string | null, type: string, message: string) {
    this.db.prepare('INSERT INTO events(at, task_key, type, message) VALUES(?,?,?,?)').run(now(), taskKey, type, message)
  }

  events(taskKey?: string, limit = 200): EventRow[] {
    const rows = taskKey
      ? this.db.prepare('SELECT * FROM events WHERE task_key = ? ORDER BY id DESC LIMIT ?').all(taskKey, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
    return (rows as Record<string, any>[]).map((row) => ({ id: row.id, at: row.at, taskKey: row.task_key, type: row.type, message: row.message }))
  }
}
