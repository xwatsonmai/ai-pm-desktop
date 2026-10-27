import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecutorSettings } from '../types.js'
import { readChunk, streamEvents } from './files.js'
import { killTree, liveness, runOnce, spawnDetached } from './process.js'
import type { Executor, PollResult, RunSpec, StartedRun, TrackedRun } from './types.js'

// The runner is compiled next to this file; tests run the TypeScript source.
const here = dirname(fileURLToPath(import.meta.url))
const RUNNER = [join(here, 'zcode-runner.js'), join(here, 'zcode-runner.ts')].find(existsSync) ?? join(here, 'zcode-runner.js')

// How to start the ZCode CLI: its script on a runtime, or a plain executable.
export function zcodeCommand(settings: ExecutorSettings): { command: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {}
  if (settings.runtime) env.ELECTRON_RUN_AS_NODE = '1' // ZCode's own app binary runs scripts in node mode
  // Inside ZCode.app the CLI looks for its provider config next to itself, where it is not.
  const builtin = resolve(dirname(settings.binary), '..', 'config', 'provider', 'zcode-builtin.json')
  if (existsSync(builtin)) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin
  return { command: settings.runtime ? [settings.runtime, settings.binary] : [settings.binary], env }
}

// Model ids in settings are "<providerId>::<modelId>", as ZCode needs both.
export function zcodeModel(model: string | undefined, effort: string | undefined) {
  if (!model) return undefined
  const [providerId, modelId] = model.split('::')
  if (!providerId || !modelId) return undefined
  return { providerId, modelId, ...(effort ? { options: { reasoningLevel: effort } } : {}) }
}

// ZCode MCP servers from a Claude-style {"mcpServers": {name: {type, url, headers}}} document.
export function zcodeMcpServers(config: string | undefined): unknown[] {
  if (!config?.trim()) return []
  const servers = (JSON.parse(config).mcpServers ?? {}) as Record<string, { type?: string; url: string; headers?: Record<string, string> }>
  return Object.entries(servers).map(([name, server]) => ({
    name, type: server.type ?? 'http', url: server.url, isolation: 'session',
    headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ name: key, value })),
  }))
}

// The last JSON object in a reply: models without schema enforcement wrap it in prose or fences.
export function replyJson(text: string): string {
  const trimmed = text.trim()
  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(trimmed)?.[1]
    if (fenced) return fenced
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed
  }
}

const SCHEMA_RULE = '\n\n最后一条回复只输出一个 JSON 对象，必须符合下面的 JSON Schema。不要加代码块、说明或其他文字：\n'

// Drives ZCode through its app-server, one detached runner process per turn.
export class ZCodeExecutor implements Executor {
  readonly name = 'zcode' as const

  // `platformUrl`: agents must not reach the AI PM platform, so a ZCode
  // configuration that adds it as an MCP server is refused.
  constructor(private readonly settings: () => ExecutorSettings, private readonly platformUrl: () => string = () => '') {}

  probe(): Promise<{ ok: boolean; detail: string }> {
    const leak = this.platformServer()
    if (leak) return Promise.resolve({ ok: false, detail: `ZCode 配置里的 MCP 服务 ${leak} 指向 AI PM 平台，请先在 ZCode 里移除` })
    const { command, env } = zcodeCommand(this.settings())
    return runOnce(command[0], [...command.slice(1), '--version'], { timeoutMs: 15_000, env: { ...process.env, ...env } })
      .then((detail) => ({ ok: true, detail: 'zcode ' + detail }), (error: Error) => ({ ok: false, detail: error.message }))
  }

  private platformServer(): string | null {
    const platform = this.platformUrl()
    const path = join(homedir(), '.zcode', 'cli', 'config.json')
    if (!platform || !existsSync(path)) return null
    try {
      const servers = (JSON.parse(readFileSync(path, 'utf8')).mcp?.servers ?? {}) as Record<string, { url?: string }>
      const origin = new URL(platform).origin
      return Object.entries(servers).find(([, s]) => typeof s.url === 'string' && s.url.startsWith(origin))?.[0] ?? null
    } catch {
      return null
    }
  }

  start(spec: RunSpec): StartedRun {
    const settings = this.settings()
    mkdirSync(spec.dir, { recursive: true })
    const logPath = join(spec.dir, 'events.jsonl')
    const outPath = join(spec.dir, 'last-message.txt')
    const requestPath = join(spec.dir, 'request.json')
    const { command, env } = zcodeCommand(settings)
    writeFileSync(requestPath, JSON.stringify({
      command, env, cwd: spec.cwd, outPath, sessionId: spec.sessionId,
      prompt: spec.prompt + SCHEMA_RULE + JSON.stringify(spec.schema),
      mode: 'yolo',
      model: zcodeModel(spec.model, spec.effort),
      mcpServers: zcodeMcpServers(settings.mcpConfig),
    }))
    // The runner needs only node; the client's own binary provides it in node mode.
    const { pid, startToken } = spawnDetached(process.execPath, [RUNNER, requestPath], {
      cwd: spec.cwd,
      logPath,
      errPath: join(spec.dir, 'stderr.log'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    return { pid, pidStart: startToken, logPath, outPath }
  }

  poll(run: TrackedRun): PollResult {
    // Liveness first: a log read before it could miss lines a quick run wrote just before exiting.
    const alive = liveness(run.pid, run.pidStart) !== 'dead'
    const sessionId = run.sessionId ?? streamEvents(readChunk(run.logPath, false, 64 * 1024)).find((e) => e.type === 'zcode.session')?.sessionId
    if (alive) return { done: false, sessionId }
    const result = streamEvents(readChunk(run.logPath, true, 512 * 1024)).findLast((e) => e.type === 'zcode.result')
    if (result?.status === 'completed' && existsSync(run.outPath)) {
      return { done: true, sessionId, outcome: { kind: 'completed', text: replyJson(readFileSync(run.outPath, 'utf8')) } }
    }
    if (result?.status === 'failed') return { done: true, sessionId, outcome: { kind: 'failed', error: result.error ?? 'failed' } }
    const stderr = readChunk(join(dirname(run.logPath), 'stderr.log'), true, 2_000).trim()
    return { done: true, sessionId, outcome: { kind: 'interrupted', error: result?.error ?? (stderr || 'process exited without a result') } }
  }

  kill(run: TrackedRun): Promise<void> {
    return killTree(run.pid)
  }
}
