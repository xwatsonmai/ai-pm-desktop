// Everything the window can ask for. No Electron imports, so it is tested with
// the fake platform like the rest of the core.
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CommandError } from '../core/commands.js'
import { Engine } from '../core/engine.js'
import { StaticToken } from '../core/platform/client.js'
import { hasLogin, login, OAuthTokenProvider } from '../core/platform/oauth.js'
import { probe } from '../core/probe.js'
import { Store, type Secrets } from '../core/store.js'
import { Slots } from '../core/slots.js'
import type { ExecutorName, ExecutorSettings, GlobalSettings, ProjectSettings, Settings, Task } from '../core/types.js'
import { git, repoPrefix } from '../core/workspace.js'
import type { Api, AppSettings, CommandName, Detail, DiffView, LogChunk, PlanView, ProbeStep, ProjectView, RequirementView, Result, Snapshot, TaskView, WorkspaceView } from '../shared/api.js'
import { executorLabel } from '../shared/labels.js'
import { entriesFor } from './agent-log.js'
import { findExecutor } from './find-executor.js'

export { findExecutor }
import { listCodexModels, type ModelInfo } from '../core/executors/codex-models.js'
import { zcodeCommand } from '../core/executors/zcode.js'
import { listZcodeModels } from '../core/executors/zcode-models.js'

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
  'abandonBatch', 'sendBackToDev', 'retry', 'takeOver', 'handBack', 'rework', 'releaseClaim', 'closeRequirement', 'retryNow', 'removeWorkspace', 'startReview', 'applyReview', 'rereview', 'skipReview',
])
const REASON_TITLES: Record<string, string> = {
  plan_confirm: '方案待确认', agent_question: 'Agent 需要你回复', ready_to_test: '可以提测', ready_to_release: '可以上线', review_ready: 'AI 评审完成',
  release_failed: '发布没有完成', output_invalid: '结果格式不合格', executor_failing: '执行器连续失败',
  platform_rejected: '平台拒绝了操作', taken_over: '你已接管',
}
const LEGACY_CONFIG = join(homedir(), '.codex', 'ai-pm-client', 'config.json')
const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml')
// Claude Code's model aliases always point at the latest model of each family.
const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'opus', name: 'Opus（最新）', isDefault: false },
  { id: 'sonnet', name: 'Sonnet（最新）', isDefault: false },
  { id: 'fable', name: 'Fable（最新）', isDefault: false },
  { id: 'haiku', name: 'Haiku（最新）', isDefault: false },
].map((m) => ({ ...m, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null }))

const quote = (value: string) => (/^[\w./:=-]+$/.test(value) ? value : `"${value}"`)

// The command that opens an agent's session in a terminal.
function takeoverCommand(executor: ExecutorName, config: ExecutorSettings | undefined, session: string): string {
  if (executor === 'claude') return `claude --resume ${session}`
  if (executor === 'zcode' && config) {
    const { command, env } = zcodeCommand(config)
    return [...Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`), ...command.map(quote), '--resume', session].join(' ')
  }
  return `codex resume ${session}`
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (code: string, message: string): Result<never> => ({ ok: false, code, message })

// One project the client serves. Its data directory holds its own store (tasks,
// login, runs) and worktrees; the first project keeps the original directory.
interface Project {
  id: string
  dataDir: string
  store: Store
  engine: Engine | null
  prefix: string
}

// The app-level file: machine-wide settings and where each project lives.
interface Registry {
  globals: GlobalSettings
  projects: { id: string; dataDir: string; name?: string }[]
}

const pickGlobals = (s: Settings): GlobalSettings => ({ executors: s.executors, allowedExecutors: s.allowedExecutors, worktreeRetentionDays: s.worktreeRetentionDays })
const projectPart = (s: Settings | ProjectSettings): ProjectSettings => {
  const { executors: _e, allowedExecutors: _a, worktreeRetentionDays: _w, ...rest } = s as Settings
  return rest
}
const isActive = (t: Task) => ['queued', 'running', 'needs_you', 'waiting'].includes(t.status)

// The last login attempt's error, unless a login worked after it.
function lastLoginError(store: Store): string | null {
  const last = store.events(undefined, 200).find((e) => e.taskKey === null && (e.type === 'login_failed' || e.type === 'login_ok'))
  return last?.type === 'login_failed' ? last.message : null
}

export class AppController extends EventEmitter implements Api {
  private readonly registryPath: string
  private registry: Registry
  private readonly projects = new Map<string, Project>()
  private readonly slots = new Slots()
  private changedTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(
    private readonly dataDir: string,
    private readonly secrets: Secrets,
    private readonly host: Host,
    private readonly legacyConfig = LEGACY_CONFIG,
    private readonly codexConfig = CODEX_CONFIG,
  ) {
    super()
    this.registryPath = join(dataDir, 'projects.json')
    this.registry = this.loadRegistry()
    for (const entry of this.registry.projects) this.open(entry.id, entry.dataDir)
  }

  // Before projects.json existed, the data directory held one project. It
  // becomes the first project in place, so its tasks and worktrees stay put.
  private loadRegistry(): Registry {
    if (existsSync(this.registryPath)) return JSON.parse(readFileSync(this.registryPath, 'utf8'))
    const registry: Registry = { globals: { executors: {}, allowedExecutors: [] }, projects: [] }
    if (existsSync(join(this.dataDir, 'db.sqlite'))) {
      const store = new Store(join(this.dataDir, 'db.sqlite'), this.secrets)
      const settings = store.getSettings()
      store.close()
      if (settings) {
        registry.globals = pickGlobals(settings)
        registry.projects.push({ id: 'main', dataDir: this.dataDir })
      }
    }
    this.saveRegistry(registry)
    return registry
  }

  private saveRegistry(registry = this.registry) {
    mkdirSync(this.dataDir, { recursive: true })
    writeFileSync(this.registryPath + '.tmp', JSON.stringify(registry, null, 2))
    renameSync(this.registryPath + '.tmp', this.registryPath)
  }

  private open(id: string, dataDir: string): Project {
    mkdirSync(dataDir, { recursive: true })
    const project: Project = { id, dataDir, store: new Store(join(dataDir, 'db.sqlite'), this.secrets), engine: null, prefix: '' }
    this.projects.set(id, project)
    return project
  }

  // A project's settings with the machine-wide ones laid over them.
  private settingsOf(project: Project): Settings | null {
    const own = project.store.getSettings()
    return own ? { ...own, ...this.registry.globals } : null
  }

  private nameOf(project: Project): string {
    return project.engine?.scheduler.projectName ?? this.registry.projects.find((p) => p.id === project.id)?.name ?? project.store.getSettings()?.projectId ?? project.id
  }

  // The project that holds a task, batch or run.
  private projectOfTask(key: string): Project | null {
    for (const project of this.projects.values()) if (project.store.getTask(key)) return project
    return null
  }

  get running(): boolean {
    return [...this.projects.values()].some((p) => p.engine)
  }

  async start() {
    for (const project of this.projects.values()) if (project.store.getSettings()) await this.startEngine(project).catch(() => {})
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.changedTimer) clearTimeout(this.changedTimer)
    for (const project of this.projects.values()) {
      await project.engine?.stop()
      project.engine = null
      project.store.close()
    }
  }

  private async startEngine(project: Project) {
    const settings = this.settingsOf(project)!
    project.prefix = await repoPrefix(settings.repoPath).catch(() => '')
    const engine = new Engine({ dataDir: project.dataDir, store: project.store, settings: () => this.settingsOf(project), slots: this.slots })
    engine.on('changed', () => this.changed())
    engine.on('needs_you', (task: Task) => {
      const title = REASON_TITLES[task.reason ?? ''] ?? '需要你处理'
      this.emit('notice', { title, body: this.projects.size > 1 ? `${this.nameOf(project)} · ${task.title}` : task.title, key: task.key } satisfies Notice)
    })
    engine.on('auth_required', () => this.emit('notice', {
      title: '需要重新登录', body: `${this.projects.size > 1 ? this.nameOf(project) + '：' : ''}AI PM 平台的登录已失效，请在设置里重新登录。`,
    } satisfies Notice))
    project.engine = engine
    await engine.start()
    this.changed()
  }

  private async restartEngine(project: Project) {
    await project.engine?.stop()
    project.engine = null
    await this.startEngine(project)
  }

  private changed() {
    if (this.changedTimer || this.stopped) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      if (!this.stopped) this.emit('changed')
    }, 150)
  }

  // ---------------- reads ----------------

  private view(project: Project, task: Task, all: Map<string, Task>): TaskView {
    const plan = (task.data.plan ?? null) as PlanView | null
    let takeover: TaskView['takeover'] = null
    const stage = task.data.takenOver?.stage ?? task.stage
    const session = task.sessions[stage]
    if (task.worktree && session) {
      const cwd = project.prefix ? resolve(task.worktree, project.prefix) : task.worktree
      const executor = stage === 'review' && task.data.reviewer ? task.data.reviewer : task.executor
      takeover = { cwd, command: `cd "${cwd}" && ${takeoverCommand(executor, this.registry.globals.executors[executor], session)}` }
    }
    return {
      key: task.key, kind: task.kind, platformId: task.platformId, title: task.title, stage: task.stage, status: task.status,
      reason: task.reason, detail: task.detail, executor: task.executor, platformStatus: task.platformStatus,
      branch: task.branch, worktree: task.worktree, createdAt: task.createdAt, updatedAt: task.updatedAt,
      failures: task.failures, lastError: task.lastError, retryAt: task.retryAt, running: task.status === 'running',
      plan, planAnswers: (task.data.planApproval?.answers ?? null) as TaskView['planAnswers'], dev: task.data.dev ?? null,
      members: (task.data.members ?? []).map((key) => ({ key, title: all.get(key)?.title ?? key, platformId: all.get(key)?.platformId ?? key })),
      batch: task.data.batch ?? null, release: task.data.release ?? null, submittedSha: task.data.submittedSha ?? null,
      project: project.id, takeover, reviewer: task.data.reviewer ?? null, reviews: task.data.reviews ?? [],
    }
  }

  private projectView(project: Project): ProjectView {
    const engine = project.engine
    const settings = project.store.getSettings()
    // Keep the platform's name for when the project is not connected.
    const name = engine?.scheduler.projectName
    const entry = this.registry.projects.find((p) => p.id === project.id)
    if (name && entry && entry.name !== name) {
      entry.name = name
      this.saveRegistry()
    }
    return {
      id: project.id, projectId: settings?.projectId ?? '', name: this.nameOf(project),
      engine: {
        running: engine?.status.running ?? false, connected: engine?.status.connected ?? false,
        lastReconcileAt: engine?.status.lastReconcileAt ?? null, lastError: engine?.status.lastError ?? null,
        bindingError: engine?.status.bindingError ?? null, authRequired: engine?.authRequired ?? false,
        contractError: engine?.status.contractError ?? null, intakePaused: settings?.intakePaused ?? false,
      },
      auth: project.store.getSecret('token') ? { mode: 'static', loggedIn: true } : { mode: 'oauth', loggedIn: hasLogin(project.store), lastError: lastLoginError(project.store) },
    }
  }

  async snapshot(): Promise<Snapshot> {
    const projects = [...this.projects.values()].filter((p) => p.store.getSettings())
    const health: Partial<Record<ExecutorName, boolean>> = {}
    for (const project of projects) {
      for (const [name, ok] of Object.entries(project.engine?.executorHealth() ?? {}) as [ExecutorName, boolean][]) health[name] = (health[name] ?? true) && ok
    }
    const tasks = projects.flatMap((project) => {
      const own = project.store.listTasks()
      const all = new Map(own.map((t) => [t.key, t]))
      return own.map((t) => this.view(project, t, all))
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const globals = this.registry.globals
    return {
      configured: projects.length > 0,
      projects: projects.map((p) => this.projectView(p)),
      executors: (['codex', 'claude', 'zcode'] as ExecutorName[]).map((name) => ({
        name, configured: !!globals.executors[name], healthy: health[name] ?? null,
        expertModel: globals.executors[name]?.models?.expert?.model ?? null,
      })),
      tasks,
    }
  }

  async detail(key: string): Promise<Detail | null> {
    const project = this.projectOfTask(key)
    if (!project) return null
    const { store } = project
    const task = store.getTask(key)!
    const all = new Map(store.listTasks().map((t) => [t.key, t]))
    // A requirement's releases run on the batches it was in; its log and timeline show them too.
    // The batch's "you" lines are already copied to each member.
    const batches = [...all.values()].filter((t) => t.kind === 'batch' && (t.data.members ?? []).includes(key)).map((t) => t.key)
    const runs = [key, ...batches].flatMap((k) => store.runsFor(k)).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    const events = [...store.events(key, 200), ...batches.flatMap((k) => store.events(k, 200).filter((e) => e.type !== 'you'))]
      .sort((a, b) => b.id - a.id).slice(0, 200)
    return {
      task: this.view(project, task, all),
      requirement: requirementOf(task),
      workspaces: await this.workspaces(project, task, all),
      runs: runs.map((run) => ({
        id: run.id, stage: run.stage, purpose: run.purpose, executor: run.executor, sessionId: run.sessionId,
        startedAt: run.startedAt, endedAt: run.endedAt, outcome: run.outcome, error: run.error,
      })),
      events: events.map(({ at, type, message }) => ({ at, type, message })),
      outbox: [key, ...batches].flatMap((k) => store.outboxFor(k)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((item) => ({
        id: item.id, tool: item.tool, status: item.status, attempts: item.attempts, lastError: item.lastError, createdAt: item.createdAt,
      })),
    }
  }

  // The task's checkouts and what is left in them. Releases made for it alone
  // count as its own; a release of several requirements keeps its own page.
  private async workspaces(project: Project, task: Task, all: Map<string, Task>): Promise<WorkspaceView[]> {
    const scheduler = project.engine?.scheduler
    if (!scheduler) return []
    const keepDays = this.registry.globals.worktreeRetentionDays ?? 14
    const releases = [...all.values()].filter((t) => t.kind === 'batch' && t.data.members?.length === 1 && t.data.members[0] === task.key)
    const views: WorkspaceView[] = []
    for (const t of [task, ...releases]) {
      const path = scheduler.checkoutDir(t)
      const exists = existsSync(path)
      if (!exists && t !== task) continue
      const finished = ['done', 'closed'].includes(t.status)
      views.push({
        label: t.kind === 'batch' ? `${t.stage === 'release' ? '上线' : '提测'}工作区` : t.kind === 'collaboration' ? '协同工作区' : '工作区',
        path, exists,
        changes: exists && t.status !== 'running' ? await scheduler.checkoutChanges(t).catch(() => []) : exists ? null : [],
        removeAt: finished ? new Date(Date.parse(t.updatedAt) + keepDays * 86_400_000).toISOString() : null,
      })
    }
    return views
  }

  // Reads complete lines from `offset`, at most 256KB per call.
  async runLog(runId: string, offset: number): Promise<LogChunk> {
    let run = null
    for (const project of this.projects.values()) if ((run = project.store.getRun(runId))) break
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
      return { entries: entriesFor(run.executor, events, offset), offset: next, done: !!run.endedAt && next >= size }
    } finally {
      closeSync(fd)
    }
  }

  async diff(key: string): Promise<DiffView | null> {
    const project = this.projectOfTask(key)
    const task = project?.store.getTask(key)
    const settings = project && this.settingsOf(project)
    if (!task?.worktree || !settings || !existsSync(task.worktree)) return null
    const head = await git(task.worktree, ['rev-parse', 'HEAD'])
    const base = await git(task.worktree, ['merge-base', 'HEAD', settings.startRef]).catch(() => head)
    const stat = await git(task.worktree, ['diff', '--stat', base, head])
    const patch = await git(task.worktree, ['diff', base, head])
    const limit = 400 * 1024
    return { base, head, stat, patch: patch.slice(0, limit), truncated: patch.length > limit }
  }

  // ---------------- writes ----------------

  // A command acts on the project that holds its task (the first, for a list of them).
  async command(name: CommandName, args: unknown[]): Promise<Result<unknown>> {
    if (!COMMANDS.has(name)) return fail('unknown_command', name)
    const key = typeof args[0] === 'string' ? args[0] : Array.isArray(args[0]) && typeof args[0][0] === 'string' ? args[0][0] : null
    const project = key ? this.projectOfTask(key) : null
    if (!project) return fail('not_found', '找不到这个任务')
    if (!project.engine) return fail('not_running', '这个项目还没有启动，请先完成设置')
    try {
      const value = await (project.engine.command as (n: string, ...a: unknown[]) => Promise<unknown>)(name, ...args)
      return ok(value)
    } catch (error) {
      if (error instanceof CommandError) return fail(error.code, error.message)
      return fail('error', error instanceof Error ? error.message : String(error))
    }
  }

  async getSettings(): Promise<AppSettings> {
    return {
      globals: this.registry.globals,
      projects: [...this.projects.values()].flatMap((p) => {
        const settings = p.store.getSettings()
        return settings ? [{ id: p.id, settings: projectPart(settings) }] : []
      }),
    }
  }

  async saveGlobals(globals: GlobalSettings): Promise<Result> {
    const problem = validateGlobals(globals)
    if (problem) return fail('invalid_settings', problem)
    const previous = this.registry.globals
    this.registry = { ...this.registry, globals }
    this.saveRegistry()
    // Executors are set up when an engine starts.
    const restart = JSON.stringify(Object.keys(previous.executors).sort()) !== JSON.stringify(Object.keys(globals.executors).sort())
    try {
      for (const project of this.projects.values()) {
        if (!project.engine) continue
        if (restart) await this.restartEngine(project)
        else project.engine.requestReconcile('settings_changed')
      }
    } catch (error) {
      return fail('start_failed', error instanceof Error ? error.message : String(error))
    }
    this.changed()
    return ok(undefined)
  }

  // Saves a project's own settings; without an id it adds a project.
  async saveProject(id: string | null, settings: ProjectSettings): Promise<Result<string>> {
    const problem = validateSettings({ ...settings, ...this.registry.globals } as Settings)
    if (problem) return fail('invalid_settings', problem)
    const clash = [...this.projects.values()].find((p) => p.id !== id && p.store.getSettings()?.projectId === settings.projectId)
    if (clash) return fail('duplicate_project', `项目 ${settings.projectId} 已经添加过了`)
    let project = id ? this.projects.get(id) : undefined
    if (id && !project) return fail('not_found', '找不到这个项目')
    if (!project) {
      // The first project keeps the original data directory; later ones get their own.
      const newId = this.projects.size === 0 ? 'main' : 'p-' + randomUUID().slice(0, 8)
      const dataDir = newId === 'main' ? this.dataDir : join(this.dataDir, 'projects', newId)
      project = this.open(newId, dataDir)
      this.registry.projects.push({ id: newId, dataDir })
      this.saveRegistry()
    }
    const previous = project.store.getSettings()
    project.store.setSettings({ ...settings, ...this.registry.globals, timing: previous?.timing ?? settings.timing } as Settings)
    const rebind = !previous || BINDING_FIELDS.some((field) => previous[field] !== settings[field])
    try {
      if (!project.engine) await this.startEngine(project)
      else if (rebind) await this.restartEngine(project)
      else project.engine.requestReconcile('settings_changed')
    } catch (error) {
      return fail('start_failed', error instanceof Error ? error.message : String(error))
    }
    this.changed()
    return ok(project.id)
  }

  // Stops serving a project. Its data directory stays on disk.
  async removeProject(id: string): Promise<Result> {
    const project = this.projects.get(id)
    if (!project) return fail('not_found', '找不到这个项目')
    const active = project.store.listTasks().filter((t) => t.kind !== 'batch' && isActive(t)).length
    if (active) return fail('has_active_tasks', `这个项目还有 ${active} 个进行中的需求，先处理完或放弃认领再移除`)
    await project.engine?.stop()
    project.store.close()
    this.projects.delete(id)
    this.registry = { ...this.registry, projects: this.registry.projects.filter((p) => p.id !== id) }
    this.saveRegistry()
    this.changed()
    return ok(undefined)
  }

  // Maps the old client's private config onto v2 settings for review. Never saves.
  // The old client ran Codex with the user's own config, so the model it used
  // comes from there; v2 skips that config and needs it written down.
  async importLegacy(): Promise<{ project: ProjectSettings; globals: GlobalSettings } | null> {
    if (!existsSync(this.legacyConfig)) return null
    const c = JSON.parse(readFileSync(this.legacyConfig, 'utf8'))
    const model = codexDefaults(this.codexConfig)
    const models = model.model || model.effort ? { expert: model, execution: model } : undefined
    const configOverrides = Object.entries(c.execution_config ?? {})
      .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
    return {
      project: {
        projectId: c.project_id, mcpUrl: c.mcp_url, resourceUri: c.resource_uri, protocolVersion: c.protocol_version,
        repository: c.repository, repoPath: c.codex_project_path, startRef: c.start_ref || 'origin/main',
        testReleaseInstructions: c.test_release_instructions ?? '', releaseInstructions: c.release_instructions ?? '',
        environmentInstructions: legacyEnvironment(c), maxOpenTasks: 5, intakePaused: true,
      },
      globals: {
        executors: { codex: { binary: c.codex_binary ?? (await this.detectExecutor('codex'))?.binary ?? '', limit: 1, models, configOverrides } },
        allowedExecutors: ['codex'],
      },
    }
  }

  async detectExecutor(name: ExecutorName): Promise<{ binary: string; runtime?: string } | null> {
    return findExecutor(name)
  }

  async login(id: string): Promise<Result> {
    const project = this.projects.get(id)
    const settings = project && this.settingsOf(project)
    if (!project || !settings) return fail('not_configured', '请先保存项目设置')
    try {
      await login({ store: project.store, serverUrl: settings.mcpUrl, port: settings.oauthRedirectPort, openBrowser: (url) => this.host.openExternal(url) })
    } catch (error) {
      // Kept on the project as well: a toast is easy to miss after coming back from the browser.
      const message = error instanceof Error ? error.message : String(error)
      project.store.event(null, 'login_failed', message)
      this.changed()
      return fail('login_failed', message)
    }
    project.store.event(null, 'login_ok', settings.mcpUrl)
    if (project.engine) {
      project.engine.status.authRequired = false
      project.engine.requestReconcile('login')
    } else {
      await this.startEngine(project).catch(() => {})
    }
    this.changed()
    return ok(undefined)
  }

  async probe(id: string): Promise<ProbeStep[]> {
    const project = this.projects.get(id)
    const settings = project && this.settingsOf(project)
    if (!project || !settings) return [{ step: '设置', ok: false, detail: '请先保存项目设置' }]
    const token = project.store.getSecret('token')
    const tokens = token ? new StaticToken(token) : new OAuthTokenProvider(project.store, settings.mcpUrl, settings.oauthRedirectPort)
    return probe(settings, tokens, 8_000)
  }

  // Pauses or resumes intake for one project, or for all of them.
  async setIntakePaused(id: string | null, paused: boolean) {
    const targets = id ? [this.projects.get(id)].filter((p): p is Project => !!p) : [...this.projects.values()]
    const problems: string[] = []
    try {
      for (const project of targets) {
        const settings = project.store.getSettings()
        if (!settings) continue
        try {
          if (project.engine) await project.engine.setIntakePaused(paused)
          else if (paused) project.store.setSettings({ ...settings, intakePaused: true })
          else throw new Error('客户端还没有连上平台，无法确认平台版本')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          problems.push(targets.length > 1 ? `${this.nameOf(project)}：${message}` : message)
        }
      }
    } finally {
      this.changed()
    }
    if (problems.length) throw new Error(problems.join('；'))
  }

  async openPath(path: string) {
    if (existsSync(path)) this.host.openPath(path)
  }

  async copy(text: string) {
    this.host.copy(text)
  }

  // The models a CLI offers, cached briefly so opening Settings stays quick.
  private modelCache = new Map<string, { at: number; models: ModelInfo[] }>()
  async listModels(executor: ExecutorName, config: { binary: string; runtime?: string }): Promise<Result<ModelInfo[]>> {
    if (executor === 'claude') return ok(CLAUDE_MODELS)
    if (!config.binary) return fail('no_binary', '请先填写程序路径')
    const key = `${executor}:${config.runtime ?? ''}:${config.binary}`
    const cached = this.modelCache.get(key)
    if (cached && Date.now() - cached.at < 5 * 60_000) return ok(cached.models)
    try {
      const models = executor === 'zcode' ? await listZcodeModels({ ...config, limit: 1 }) : await listCodexModels(config.binary)
      this.modelCache.set(key, { at: Date.now(), models })
      return ok(models)
    } catch (error) {
      return fail('models_unavailable', '读不到模型列表：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  async launchAtLogin() {
    return this.host.launchAtLogin()
  }

  async setLaunchAtLogin(on: boolean) {
    this.host.setLaunchAtLogin(on)
  }
}

// Executors and the other machine-wide settings.
export function validateGlobals(g: GlobalSettings): string | null {
  if (!g.allowedExecutors?.length) return '请至少启用一个执行器'
  for (const name of g.allowedExecutors) {
    const executor = g.executors[name]
    if (!executor?.binary) return `请填写 ${executorLabel(name)} 的程序路径`
    if (!Number.isInteger(executor.limit) || executor.limit < 1 || executor.limit > 8) return `${executorLabel(name)} 的名额需要是 1 到 8 之间的整数`
    if ((executor.configOverrides ?? []).some((line) => line.trim() && !/^[\w.-]+\s*=/.test(line.trim()))) {
      return `${executorLabel(name)} 配置覆盖的每一行需要是 key=value`
    }
    if (executor.mcpConfig?.trim()) {
      try {
        const servers = JSON.parse(executor.mcpConfig).mcpServers
        if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error()
      } catch {
        return `${executorLabel(name)} 的 MCP 配置需要是 {"mcpServers": {...}} 格式的 JSON`
      }
    }
  }
  if (g.worktreeRetentionDays !== undefined && (!Number.isInteger(g.worktreeRetentionDays) || g.worktreeRetentionDays < 1)) {
    return '保留工作区的天数至少为 1'
  }
  return null
}

// A project's settings, with the machine-wide ones it runs with.
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
  if (!Number.isInteger(s.maxOpenTasks) || s.maxOpenTasks < 1) return '同时处理的需求上限至少为 1'
  return validateGlobals(s)
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
