import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnDetached } from './process.js'
import type { RunSpec } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
const runner = [join(here, 'interactive-runner.js'), join(here, 'interactive-runner.ts')].find(existsSync)!

export function startInteractive(kind: 'codex' | 'claude', binary: string, args: string[], spec: RunSpec, isolate = true) {
  mkdirSync(spec.dir, { recursive: true, mode: 0o700 })
  const logPath = join(spec.dir, 'events.jsonl'), outPath = join(spec.dir, 'last-message.txt')
  const requestPath = join(spec.dir, 'interactive-request.json')
  const prompt = spec.prompt + '\n\n运行期间可能收到用户补充指令。执行后续步骤前优先阅读最新用户消息，在不打断已启动工具命令的前提下调整后续行动；最终仍按本轮 JSON Schema 输出。'
  writeFileSync(requestPath, JSON.stringify({ kind, binary, args, spec: { ...spec, prompt }, outPath, isolate }), { mode: 0o600 })
  const { pid, startToken } = spawnDetached(process.execPath, [runner, requestPath], {
    cwd: spec.cwd, logPath, errPath: join(spec.dir, 'stderr.log'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  return { pid, pidStart: startToken, logPath, outPath }
}
