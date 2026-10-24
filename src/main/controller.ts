// Everything the window can ask for. No Electron imports, so it is tested with
// the fake platform like the rest of the core.
import { EventEmitter } from 'node:events'
import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CommandError } from '../core/commands.js'
import { Engine } from '../core/engine.js'
import { StaticToken } from '../core/platform/client.js'
import { hasLogin, login, OAuthTokenProvider } from '../core/platform/oauth.js'
import { probe } from '../core/probe.js'
import { Store, type Secrets } from '../core/store.js'
import type { ExecutorName, Settings, Task } from '../core/types.js'
import { git, repoPrefix } from '../core/workspace.js'
import type { Api, CommandName, Detail, DiffView, LogChunk, PlanView, ProbeStep, RequirementView, Result, Snapshot, TaskView } from '../shared/api.js'
import { codexEntries } from './codex-log.js'

export interface Host {
  openExternal(url: string): void
  openPath(path: string): void
  copy(text: string): void
  launchAtLogin(): boolean
  setLaunchAtLogin(on: boolean): void
}

export interface Notice {
  title: string
  body: string
  key?: string
}

const BINDING_FIELDS = ['projectId', 'mcpUrl', 'resourceUri', 'protocolVersion', 'repository', 'repoPath', 'oauthRedirectPort'] as const
const COMMANDS = new Set<CommandName>([
  'confirmPlan', 'revisePlan', 'answer', 'requestChanges', 'submitTest', 'release', 'continueRelease', 'markReleased',
  'abandonBatch', 'sendBackToDev', 'retry', 'takeOver', 'handBack', 'rework', 'releaseClaim', 'closeRequirement', 'retryNow',
])
const REASON_TITLES: Record<string, string> = {
  plan_confirm: '方案待确认', agent_question: 'Agent 需要你回复', ready_to_test: '可以提测', ready_to_release: '可以上线',
  release_failed: '发布没有完成', output_invalid: '结果格式不合格', executor_failing: '执行器连续失败',
  platform_rejected: '平台拒绝了操作', taken_over: '你已接管',
}
const LEGACY_CONFIG = join(homedir(), '.codex', 'ai-pm-client', 'config.json')
const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml')
const CODEX_CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  join(homedir(), '.local', 'bin', 'codex'),
]

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (code: string, message: string): Result<never> => ({ ok: false, code, message })

export class AppController extends EventEmitter implements Api {
  readonly store: Store
  engine: Engine | null = null
  private prefix = ''
  private changedTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly dataDir: string,
    secrets: Secrets,
    private readonly host: Host,
    private readonly legacyConfig = LEGACY_CONFIG,
    private readonly codexConfig = CODEX_CONFIG,
  ) {
    super()
    this.store = new Store(join(dataDir, 'db.sqlite'), secrets)
  }

  async start() {
    if (!this.store.getSettings()) return
    await this.startEngine()
  }

  private stopped = false

  async stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.changedTimer) clearTimeout(this.changedTimer)
    await this.engine?.stop()
    this.engine = null
    this.store.close()
  }

  private async startEngine() {
    const settings = this.store.getSettings()!
    this.prefix = await repoPrefix(settings.repoPath).catch(() => '')
    const engine = new Engine({ dataDir: this.dataDir, store: this.store })
    engine.on('changed', () => this.changed())
    engine.on('needs_you', (task: Task) => {
      this.emit('notice', { title: REASON_TITLES[task.reason ?? ''] ?? '需要你处理', body: task.title, key: task.key } satisfies Notice)
    })
    engine.on('auth_required', () => this.emit('notice', { title: '需要重新登录', body: 'AI PM 平台的登录已失效，请在设置里重新登录。' } satisfies Notice))
    this.engine = engine
    await engine.start()
    this.changed()
  }

  private async restartEngine() {
    await this.engine?.stop()
    this.engine = null
    await this.startEngine()
  }

  private changed() {
    if (this.changedTimer || this.stopped) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      if (!this.stopped) this.emit('changed')
    }, 150)
  }

  // ---------------- reads ----------------

  private view(task: Task, all: Map<string, Task>): TaskView {
    const plan = (task.data.plan ?? null) as PlanView | null
    let takeover: TaskView['takeover'] = null
    const stage = task.data.takenOver?.stage ?? task.stage
    const session = task.sessions[stage]
    if (task.worktree && session) {
      const cwd = this.prefix ? resolve(task.worktree, this.prefix) : task.worktree
      takeover = { cwd, command: `cd "${cwd}" && codex resume ${session}` }
    }
    return {
      key: task.key, kind: task.kind, platformId: task.platformId, title: task.title, stage: task.stage, status: task.status,
      reason: task.reason, detail: task.detail, executor: task.executor, platformStatus: task.platformStatus,
      branch: task.branch, worktree: task.worktree, createdAt: task.createdAt, updatedAt: task.updatedAt,
      failures: task.failures, lastError: task.lastError, retryAt: task.retryAt, running: task.status === 'running',
      plan, planAnswers: (task.data.planApproval?.answers ?? null) as TaskView['planAnswers'], dev: task.data.dev ?? null,
      members: (task.data.members ?? []).map((key) => ({ key, title: all.get(key)?.title ?? key, platformId: all.get(key)?.platformId ?? key })),
      batch: task.data.batch ?? null, release: task.data.release ?? null, submittedSha: task.data.submittedSha ?? null, takeover,
    }
  }

  async snapshot(): Promise<Snapshot> {
    const settings = this.store.getSettings()
    const tasks = this.store.listTasks()
    const all = new Map(tasks.map((t) => [t.key, t]))
    const engine = this.engine
    const health = engine?.executorHealth() ?? {}
    const names: ExecutorName[] = ['codex', 'claude', 'zcode']
    return {
      configured: !!settings,
      engine: {
        running: engine?.status.running ?? false, connected: engine?.status.connected ?? false,
        lastReconcileAt: engine?.status.lastReconcileAt ?? null, lastError: engine?.status.lastError ?? null,
        bindingError: engine?.status.bindingError ?? null, authRequired: engine?.authRequired ?? false,
        contractError: engine?.status.contractError ?? null,
        intakePaused: settings?.intakePaused ?? false,
      },
      auth: this.store.getSecret('token') ? { mode: 'static', loggedIn: true } : { mode: 'oauth', loggedIn: hasLogin(this.store) },
      executors: names.map((name) => ({ name, configured: !!settings?.executors[name], healthy: health[name] ?? null })),
      tasks: tasks.reverse().map((t) => this.view(t, all)),
    }
  }

  async detail(key: string): Promise<Detail | null> {
    const task = this.store.getTask(key)
    if (!task) return null
    const all = new Map(this.store.listTasks().map((t) => [t.key, t]))
    return {
      task: this.view(task, all),
      requirement: requirementOf(task),
      runs: this.store.runsFor(key).map((run) => ({
        id: run.id, stage: run.stage, purpose: run.purpose, executor: run.executor, sessionId: run.sessionId,
        startedAt: run.startedAt, endedAt: run.endedAt, outcome: run.outcome, error: run.error,
      })),
      events: this.store.events(key, 200),
      outbox: this.store.outboxFor(key).map((item) => ({
        id: item.id, tool: item.tool, status: item.status, attempts: item.attempts, lastError: item.lastError, createdAt: item.createdAt,
      })),
    }
  }

  // Reads complete lines from `offset`, at most 256KB per call.
  async runLog(runId: string, offset: number): Promise<LogChunk> {
    const run = this.store.getRun(runId)
    if (!run || !existsSync(run.logPath)) return { entries: [], offset, done: !!run?.endedAt }
    const fd = openSync(run.logPath, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size - offset, 256 * 1024)
      if (length <= 0) return { entries: [], offset, done: !!run.endedAt }
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, offset)
      const text = buffer.toString('utf8')
      const end = text.lastIndexOf('\n') + 1
      const events = text.slice(0, end).split('\n').flatMap((line) => {
        try {
          return line.startsWith('{') ? [JSON.parse(line)] : []
        } catch {
          return []
        }
      })
      const next = offset + Buffer.byteLength(text.slice(0, end))
      return { entries: codexEntries(events), offset: next, done: !!run.endedAt && next >= size }
    } finally {
      closeSync(fd)
    }
  }

  async diff(key: string): Promise<DiffView | null> {
    const task = this.store.getTask(key)
    const settings = this.store.getSettings()
    if (!task?.worktree || !settings || !existsSync(task.worktree)) return null
    const head = await git(task.worktree, ['rev-parse', 'HEAD'])
    const base = await git(task.worktree, ['merge-base', 'HEAD', settings.startRef]).catch(() => head)
    const stat = await git(task.worktree, ['diff', '--stat', base, head])
    const patch = await git(task.worktree, ['diff', base, head])
    const limit = 400 * 1024
    return { base, head, stat, patch: patch.slice(0, limit), truncated: patch.length > limit }
  }

  // ---------------- writes ----------------

  async command(name: CommandName, args: unknown[]): Promise<Result<unknown>> {
    if (!COMMANDS.has(name)) return fail('unknown_command', name)
    if (!this.engine) return fail('not_running', '客户端还没有启动，请先完成设置')
    try {
      const value = await (this.engine.command as (n: string, ...a: unknown[]) => Promise<unknown>)(name, ...args)
      return ok(value)
    } catch (error) {
      if (error instanceof CommandError) return fail(error.code, error.message)
      return fail('error', error instanceof Error ? error.message : String(error))
    }
  }

  async getSettings(): Promise<Settings | null> {
    return this.store.getSettings()
  }

  async saveSettings(settings: Settings): Promise<Result> {
    const problem = validateSettings(settings)
    if (problem) return fail('invalid_settings', problem)
    const previous = this.store.getSettings()
    this.store.setSettings({ ...settings, timing: previous?.timing ?? settings.timing })
    const rebind = !previous || BINDING_FIELDS.some((field) => previous[field] !== settings[field]) ||
      JSON.stringify(Object.keys(previous.executors).sort()) !== JSON.stringify(Object.keys(settings.executors).sort())
    try {
      if (!this.engine) await this.startEngine()
      else if (rebind) await this.restartEngine()
      else this.engine.requestReconcile('settings_changed')
    } catch (error) {
      return fail('start_failed', error instanceof Error ? error.message : String(error))
    }
    this.changed()
    return ok(undefined)
  }

  // Maps the old client's private config onto v2 settings for review. Never saves.
  // The old client ran Codex with the user's own config, so the model it used
  // comes from there; v2 skips that config and needs it written down.
  async importLegacy(): Promise<Settings | null> {
    if (!existsSync(this.legacyConfig)) return null
    const c = JSON.parse(readFileSync(this.legacyConfig, 'utf8'))
    const model = codexDefaults(this.codexConfig)
    const models = model.model || model.effort ? { expert: model, execution: model } : undefined
    const configOverrides = Object.entries(c.execution_config ?? {})
      .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
    return {
      projectId: c.project_id, mcpUrl: c.mcp_url, resourceUri: c.resource_uri, protocolVersion: c.protocol_version,
      repository: c.repository, repoPath: c.codex_project_path, startRef: c.start_ref || 'origin/main',
      executors: { codex: { binary: c.codex_binary ?? (await this.detectCodex()) ?? '', limit: 1, models, configOverrides } },
      allowedExecutors: ['codex'],
      testReleaseInstructions: c.test_release_instructions ?? '', releaseInstructions: c.release_instructions ?? '',
      environmentInstructions: legacyEnvironment(c), maxOpenTasks: 5, intakePaused: true,
    }
  }

  async detectCodex(): Promise<string | null> {
    for (const path of CODEX_CANDIDATES) {
      try {
        accessSync(path, constants.X_OK)
        return path
      } catch {
        // Try the next location.
      }
    }
    return null
  }

  async login(): Promise<Result> {
    const settings = this.store.getSettings()
    if (!settings) return fail('not_configured', '请先保存项目设置')
    try {
      await login({ store: this.store, serverUrl: settings.mcpUrl, port: settings.oauthRedirectPort, openBrowser: (url) => this.host.openExternal(url) })
    } catch (error) {
      return fail('login_failed', error instanceof Error ? error.message : String(error))
    }
    if (this.engine) {
      this.engine.status.authRequired = false
      this.engine.requestReconcile('login')
    } else {
      await this.startEngine().catch(() => {})
    }
    this.changed()
    return ok(undefined)
  }

  async probe(): Promise<ProbeStep[]> {
    const settings = this.store.getSettings()
    if (!settings) return [{ step: '设置', ok: false, detail: '请先保存项目设置' }]
    const token = this.store.getSecret('token')
    const tokens = token ? new StaticToken(token) : new OAuthTokenProvider(this.store, settings.mcpUrl, settings.oauthRedirectPort)
    return probe(settings, tokens, 8_000)
  }

  async setIntakePaused(paused: boolean) {
    try {
      if (this.engine) await this.engine.setIntakePaused(paused)
      else if (paused) {
        const settings = this.store.getSettings()
        if (settings) this.store.setSettings({ ...settings, intakePaused: true })
      } else {
        throw new Error('客户端还没有连上平台，无法确认平台版本')
      }
    } finally {
      this.changed()
    }
  }

  async openPath(path: string) {
    if (existsSync(path)) this.host.openPath(path)
  }

  async copy(text: string) {
    this.host.copy(text)
  }

  async launchAtLogin() {
    return this.host.launchAtLogin()
  }

  async setLaunchAtLogin(on: boolean) {
    this.host.setLaunchAtLogin(on)
  }
}

export function validateSettings(s: Settings): string | null {
  const required: [keyof Settings, string][] = [
    ['projectId', '项目 ID'], ['mcpUrl', 'MCP 地址'], ['resourceUri', '订阅资源 URI'], ['repository', '平台仓库地址'],
    ['repoPath', '本地仓库路径'], ['startRef', '开发起始分支'],
  ]
  for (const [field, label] of required) if (!String(s[field] ?? '').trim()) return `请填写${label}`
  try {
    new URL(s.mcpUrl)
  } catch {
    return 'MCP 地址不是有效的 URL'
  }
  if (!existsSync(s.repoPath)) return '本地仓库路径不存在'
  if (!s.allowedExecutors?.length) return '请至少启用一个执行器'
  for (const name of s.allowedExecutors) {
    const executor = s.executors[name]
    if (!executor?.binary) return `请填写 ${name} 的程序路径`
    if (!Number.isInteger(executor.limit) || executor.limit < 1 || executor.limit > 8) return `${name} 的名额需要是 1 到 8 之间的整数`
  }
  if (!Number.isInteger(s.maxOpenTasks) || s.maxOpenTasks < 1) return '同时处理的需求上限至少为 1'
  if (s.worktreeRetentionDays !== undefined && (!Number.isInteger(s.worktreeRetentionDays) || s.worktreeRetentionDays < 1)) {
    return '保留工作区的天数至少为 1'
  }
  for (const name of s.allowedExecutors) {
    if ((s.executors[name]?.configOverrides ?? []).some((line) => line.trim() && !/^[\w.-]+\s*=/.test(line.trim()))) {
      return `${name} 配置覆盖的每一行需要是 key=value`
    }
  }
  return null
}

// The requirement as the platform holds it, from the context saved at the last refresh.
export function requirementOf(task: Task): RequirementView | null {
  const ctx = task.data.context as any
  if (!ctx || task.kind === 'batch') return null
  if (task.kind === 'collaboration') {
    return {
      title: ctx.title ?? task.title, kind: 'collaboration', revision: null, acceptance: [], decisions: [], original: null, parent: null,
      description: [ctx.brief, ctx.environment ? '环境：' + ctx.environment : ''].filter(Boolean).join('\n\n'),
    }
  }
  const t = ctx.task
  if (!t) return null
  const review = ctx.requirement_review
  const original = typeof review?.source?.description === 'string' ? review.source.description : null
  return {
    title: t.title ?? task.title, kind: t.kind ?? 'requirement', revision: t.revision ?? null,
    description: t.description ?? '', acceptance: Array.isArray(t.acceptance) ? t.acceptance : [],
    decisions: (Array.isArray(review?.agenda) ? review.agenda : [])
      .filter((a: any) => typeof a?.conclusion === 'string' && a.conclusion.trim())
      .map((a: any) => ({ title: String(a.title ?? ''), conclusion: a.conclusion })),
    original: original && original.trim() !== String(t.description ?? '').trim() ? original : null,
    parent: t.bug_context ? { description: String(t.bug_context.description ?? ''), acceptance: t.bug_context.acceptance ?? [] } : null,
  }
}

// The model and reasoning effort set at the top of Codex's own config.toml.
function codexDefaults(path: string): { model?: string; effort?: string } {
  if (!existsSync(path)) return {}
  const top = readFileSync(path, 'utf8').split(/^\[/m)[0]
  const value = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(top)?.[1]
  return { model: value('model'), effort: value('model_reasoning_effort') }
}

// What the old client told agents about reaching test and production systems,
// plus where its release environments are. Credentials never appear here.
function legacyEnvironment(c: any): string {
  const parts: string[] = []
  if (typeof c.execution_environment_instructions === 'string' && c.execution_environment_instructions.trim()) {
    parts.push(c.execution_environment_instructions.trim())
  }
  const environments = Array.isArray(c.release_environments) ? c.release_environments : []
  if (environments.length) {
    parts.push(['发布环境（具体步骤以发布说明和项目文档为准）：', ...environments.map((e: any) =>
      `- ${e.name ?? e.id}（${e.id}）：${e.address ?? '无地址'}${e.ssh?.host ? '，SSH 主机 ' + e.ssh.host : ''}${e.root ? '，部署目录 ' + e.root : ''}`)].join('\n'))
  }
  return parts.join('\n\n')
}
