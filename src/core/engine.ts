import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { Commands } from './commands.js'
import { ClaudeExecutor } from './executors/claude.js'
import { CodexExecutor } from './executors/codex.js'
import { ZCodeExecutor } from './executors/zcode.js'
import type { Executor } from './executors/types.js'
import { McpPlatform, PlatformError, StaticToken, type Platform, type TokenProvider } from './platform/client.js'
import { OAuthTokenProvider } from './platform/oauth.js'
import { Outbox } from './platform/outbox.js'
import { BindingError, Scheduler } from './scheduler.js'
import type { Slots } from './slots.js'
import { plainSecrets, Store, type Secrets } from './store.js'
import { DEFAULT_TIMING, type ExecutorName, type Settings, type Task, type Timing } from './types.js'

export interface EngineOptions {
  dataDir: string
  secrets?: Secrets
  store?: Store // shared with the caller, who then owns closing it
  platform?: Platform
  tokens?: TokenProvider
  executors?: Partial<Record<ExecutorName, Executor>>
  // The effective settings when they are not just the store's: a project's own
  // settings with the machine-wide ones (executors) laid over them.
  settings?: () => Settings | null
  slots?: Slots // executor slots shared with other projects' engines
}

export interface EngineStatus {
  running: boolean
  connected: boolean
  lastReconcileAt: string | null
  lastError: string | null
  bindingError: string | null
  authRequired: boolean
  contractError: string | null
}

// Owns the timers: the tick loop for local work, the platform subscription, and
// the polling fallback. Emits "changed" whenever state may have moved.
export class Engine extends EventEmitter {
  readonly store: Store
  readonly platform: Platform
  readonly scheduler: Scheduler
  readonly commands: Commands
  readonly status: EngineStatus = { running: false, connected: false, lastReconcileAt: null, lastError: null, bindingError: null, authRequired: false, contractError: null }
  private readonly ownsStore: boolean
  private readonly outbox: Outbox
  private readonly tokens: TokenProvider
  private readonly executors: Partial<Record<ExecutorName, Executor>>
  private wake: (() => void) | null = null
  private tickBusy: Promise<void> | null = null
  private tickAgain = false
  private reconcileBusy: Promise<void> | null = null
  private reconcileAgain = false
  private tickTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private probeTimer: NodeJS.Timeout | null = null
  private listenAbort: AbortController | null = null
  private listening: Promise<void> | null = null

  constructor(options: EngineOptions) {
    super()
    this.ownsStore = !options.store
    this.store = options.store ?? new Store(join(options.dataDir, 'db.sqlite'), options.secrets ?? plainSecrets)
    const read = options.settings ?? (() => this.store.getSettings())
    this.readSettings = read
    const settings = () => {
      const value = read()
      if (!value) throw new Error('not_configured')
      return value
    }
    const timing = (): Timing => ({ ...DEFAULT_TIMING, ...(read()?.timing ?? {}) })
    const current = settings()
    const staticToken = this.store.getSecret('token')
    this.tokens = options.tokens ?? (staticToken ? new StaticToken(staticToken) : new OAuthTokenProvider(this.store, current.mcpUrl, current.oauthRedirectPort))
    this.platform = options.platform ?? new McpPlatform(current.mcpUrl, current.resourceUri, this.tokens, timing().callTimeoutMs, current.protocolVersion)
    this.outbox = new Outbox(this.store, this.platform, this.tokens, timing)
    this.executors = options.executors ?? defaultExecutors(settings)
    this.scheduler = new Scheduler({
      store: this.store, platform: this.platform, outbox: this.outbox, executors: this.executors, settings, timing,
      dataDir: options.dataDir, onNeedsYou: (task) => this.emit('needs_you', task), slots: options.slots,
    })
    this.commands = new Commands(this.store, this.scheduler, settings)
  }

  private readonly readSettings: () => Settings | null

  private timing(): Timing {
    return { ...DEFAULT_TIMING, ...(this.readSettings()?.timing ?? {}) }
  }

  async start() {
    this.status.running = true
    await this.probe()
    this.listening = this.listenLoop()
    this.requestReconcile('startup')
    this.requestTick()
  }

  async stop() {
    this.status.running = false
    for (const timer of [this.tickTimer, this.pollTimer, this.probeTimer]) if (timer) clearTimeout(timer)
    this.listenAbort?.abort()
    this.wake?.()
    await this.listening?.catch(() => {})
    await this.tickBusy
    await this.reconcileBusy
    await this.platform.close()
    this.scheduler.detach()
    if (this.ownsStore) this.store.close()
  }

  executorHealth(): Partial<Record<ExecutorName, boolean>> {
    return { ...this.scheduler.health }
  }

  // Auth state is "required" from the moment the platform refuses our token
  // until a call succeeds again.
  get authRequired(): boolean {
    return this.status.authRequired || this.outbox.authBlocked
  }

  private noteAuth(error: unknown) {
    if (error instanceof PlatformError && error.kind === 'auth') {
      if (!this.status.authRequired) {
        this.status.authRequired = true
        this.emit('auth_required')
      }
    }
  }

  // Runs a user command, then lets the scheduler act on it right away.
  async command<K extends keyof Commands>(name: K, ...args: Parameters<Commands[K]>): Promise<Awaited<ReturnType<Commands[K]>>> {
    const result = await (this.commands[name] as (...a: unknown[]) => Promise<unknown>)(...args)
    this.emit('changed')
    this.requestTick()
    return result as Awaited<ReturnType<Commands[K]>>
  }

  // Resuming checks the platform first and refuses, staying paused, when the
  // platform cannot report error codes or cannot be asked right now.
  async setIntakePaused(paused: boolean) {
    if (!paused) {
      let problem: string | null
      try {
        problem = await this.scheduler.checkContract(true)
      } catch (error) {
        throw new Error('暂时无法确认平台版本，没有恢复接单：' + (error instanceof Error ? error.message : String(error)))
      } finally {
        this.status.contractError = this.scheduler.contractError
        this.emit('changed')
      }
      if (problem) throw new Error(problem)
    }
    // Intake belongs to the project, so it goes to the project's own settings.
    const settings = this.store.getSettings()!
    this.store.setSettings({ ...settings, intakePaused: paused })
    if (!paused) this.requestReconcile('intake_resumed')
    this.emit('changed')
  }

  tasks(): Task[] {
    return this.store.listTasks()
  }

  private async probe() {
    for (const [name, executor] of Object.entries(this.executors) as [ExecutorName, Executor][]) {
      const result = await executor.probe()
      this.scheduler.health[name] = result.ok
      if (!result.ok) this.store.event(null, 'executor_unavailable', `${name}: ${result.detail}`)
    }
    if (this.status.running) this.probeTimer = setTimeout(() => void this.probe(), this.timing().probeMs)
  }

  requestTick() {
    if (!this.status.running) return
    if (this.tickBusy) {
      this.tickAgain = true
      return
    }
    if (this.tickTimer) clearTimeout(this.tickTimer)
    this.tickBusy = (async () => {
      try {
        await this.scheduler.tick()
      } catch (error) {
        this.status.lastError = error instanceof Error ? error.message : String(error)
      }
    })().finally(() => {
      this.tickBusy = null
      this.emit('changed')
      if (!this.status.running) return
      if (this.tickAgain) {
        this.tickAgain = false
        this.requestTick()
      } else {
        this.tickTimer = setTimeout(() => this.requestTick(), this.timing().tickMs)
      }
    })
  }

  requestReconcile(reason: string) {
    if (!this.status.running) return
    if (this.reconcileBusy) {
      this.reconcileAgain = true
      return
    }
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.reconcileBusy = (async () => {
      try {
        await this.scheduler.reconcile()
        this.status.contractError = this.scheduler.contractError
        this.status.lastReconcileAt = new Date().toISOString()
        this.status.lastError = null
        this.status.bindingError = null
        this.status.authRequired = false
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.noteAuth(error)
        this.status.lastError = message
        if (error instanceof BindingError) this.status.bindingError = message
        this.store.event(null, 'reconcile_failed', `${reason}: ${message}`)
      }
    })().finally(() => {
      this.reconcileBusy = null
      if (!this.status.running) return
      this.requestTick()
      if (this.reconcileAgain) {
        this.reconcileAgain = false
        this.requestReconcile('coalesced')
        return
      }
      // Fallback in case a notification is lost.
      const active = this.store.listTasks({ status: ['queued', 'running', 'waiting'] }).length > 0
      const timing = this.timing()
      this.pollTimer = setTimeout(() => this.requestReconcile('poll'), active ? timing.pollActiveMs : timing.pollIdleMs)
    })
  }

  private async listenLoop() {
    let attempt = 0
    while (this.status.running) {
      this.listenAbort = new AbortController()
      try {
        await this.platform.listen({
          onAck: () => {
            attempt = 0
            this.status.connected = true
            this.status.authRequired = false
            this.emit('changed')
            this.requestReconcile('subscribed')
          },
          onUpdate: () => this.requestReconcile('updated'),
        }, this.listenAbort.signal)
      } catch (error) {
        if (error instanceof PlatformError && error.kind === 'auth') {
          await this.tokens.refresh().catch((refreshError) => this.noteAuth(refreshError))
        }
        this.noteAuth(error)
        this.status.lastError = error instanceof Error ? error.message : String(error)
      }
      if (this.status.connected) this.emit('changed')
      this.status.connected = false
      if (!this.status.running) break
      const delays = this.timing().reconnectMs
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delays[Math.min(attempt++, delays.length - 1)])
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wake = null
    }
  }
}

function defaultExecutors(settings: () => Settings): Partial<Record<ExecutorName, Executor>> {
  const executors: Partial<Record<ExecutorName, Executor>> = {}
  if (settings().executors.codex) executors.codex = new CodexExecutor(() => settings().executors.codex!)
  if (settings().executors.claude) executors.claude = new ClaudeExecutor(() => settings().executors.claude!)
  if (settings().executors.zcode) executors.zcode = new ZCodeExecutor(() => settings().executors.zcode!, () => settings().mcpUrl)
  return executors
}
