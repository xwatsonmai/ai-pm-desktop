import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Engine } from '../src/core/engine.js'
import { killTree } from '../src/core/executors/process.js'
import { Store } from '../src/core/store.js'
import type { ExecutorName, ExecutorSettings, Settings, Task } from '../src/core/types.js'
import { FakePlatform, TOKEN } from './fake-platform.js'

export const FAKE_CODEX = resolve(import.meta.dirname, 'fake-codex.mjs')
export const FAKE_CLAUDE = resolve(import.meta.dirname, 'fake-claude.mjs')
export const FAKE_ZCODE = resolve(import.meta.dirname, 'fake-zcode.mjs')

// The fake CLI behind each executor. ZCode's script runs on a separate runtime, as in ZCode.app.
export function fakeExecutor(name: ExecutorName, limit = 1): ExecutorSettings {
  if (name === 'claude') return { binary: FAKE_CLAUDE, limit }
  if (name === 'zcode') return { binary: FAKE_ZCODE, runtime: process.execPath, limit }
  return { binary: FAKE_CODEX, limit }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export interface World {
  root: string
  origin: string
  repoPath: string
  dataDir: string
  fake: FakePlatform
  scenarioPath: string
  logPath: string
  engine: Engine
  settings: Settings
  restart(): Promise<Engine>
  invocations(): any[]
  task(key: string): Task
  dispose(): Promise<void>
}

export async function makeWorld(options: {
  scenario?: Record<string, unknown[]>
  limit?: number
  settings?: Partial<Settings>
  subdir?: string
  files?: Record<string, string>
  executor?: ExecutorName
} = {}): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'ai-pm-desktop-'))
  const origin = join(root, 'origin.git')
  const repoPath = join(root, 'repo')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(root, 'clone', '-q', origin, repoPath)
  git(repoPath, 'config', 'user.email', 'test@example.com')
  git(repoPath, 'config', 'user.name', 'Test')
  writeFileSync(join(repoPath, 'README.md'), '# demo\n')
  if (options.subdir) {
    mkdirSync(join(repoPath, options.subdir))
    writeFileSync(join(repoPath, options.subdir, 'main.go'), 'package main\n')
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(repoPath, path)), { recursive: true })
    writeFileSync(join(repoPath, path), content)
  }
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-q', '-m', 'init')
  git(repoPath, 'push', '-q', 'origin', 'HEAD:main')

  const fake = new FakePlatform(origin)
  await fake.start()
  const scenarioPath = join(root, 'scenario.json')
  const logPath = join(root, 'codex-calls.jsonl')
  writeFileSync(scenarioPath, JSON.stringify(options.scenario ?? {}))
  writeFileSync(logPath, '')
  process.env.FAKE_CODEX_SCENARIO = scenarioPath
  process.env.FAKE_CODEX_LOG = logPath
  // The fake agent commits inside worktrees.
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Agent'
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'agent@example.com'

  const dataDir = join(root, 'data')
  const settings: Settings = {
    projectId: 'prj_test', mcpUrl: fake.url, resourceUri: fake.resourceUri, repository: origin,
    repoPath: options.subdir ? join(repoPath, options.subdir) : repoPath,
    startRef: 'origin/main', executors: { [options.executor ?? 'codex']: fakeExecutor(options.executor ?? 'codex', options.limit ?? 1) },
    allowedExecutors: [options.executor ?? 'codex'], testReleaseInstructions: '合并到 test 分支后部署测试环境，并检查健康接口。',
    releaseInstructions: '部署生产环境，并检查健康接口。', maxOpenTasks: 10,
    timing: {
      tickMs: 40, pollActiveMs: 400, pollIdleMs: 400, backoffMs: [40, 80, 160], reconnectMs: [40, 80],
      collabReportMs: 200, callTimeoutMs: 5_000, bindingCheckMs: 0, probeMs: 60_000,
    },
    ...options.settings,
  }
  const store = new Store(join(dataDir, 'db.sqlite'))
  store.setSettings(settings)
  store.setSecret('token', TOKEN)
  store.close()

  const world: World = {
    root, origin, repoPath, dataDir, fake, scenarioPath, logPath, settings,
    engine: new Engine({ dataDir }),
    async restart() {
      await world.engine.stop()
      world.engine = new Engine({ dataDir })
      await world.engine.start()
      return world.engine
    },
    invocations() {
      return execFileSync('cat', [logPath], { encoding: 'utf8' }).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    },
    task(key: string) {
      return world.engine.store.getTask(key)!
    },
    async dispose() {
      // Agents run detached and outlive the engine; one still writing would race the removal.
      const open = (() => {
        try {
          return world.engine.store.openRuns()
        } catch {
          return []
        }
      })()
      await world.engine.stop().catch(() => {})
      await Promise.all(open.map((run) => killTree(run.pid)))
      await fake.stop()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    },
  }
  await world.engine.start()
  return world
}

export async function until<T>(read: () => T, accept: (value: T) => boolean, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T = read()
  while (Date.now() < deadline) {
    last = read()
    if (accept(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(last)}`)
}

export async function untilState(world: World, key: string, status: string, reason?: string | null, timeoutMs?: number): Promise<Task> {
  const task = await until(
    () => world.engine.store.getTask(key),
    (t) => !!t && t.status === status && (reason === undefined || t.reason === reason),
    `${key} → ${status}${reason ? '/' + reason : ''}`,
    timeoutMs,
  )
  return task!
}
