import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ExecutorName } from '../core/types.js'

export interface Machine {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  exists: (file: string) => boolean
  directories?: (dir: string) => string[]
  modified?: (file: string) => number
}

const thisMachine: Machine = {
  platform: process.platform,
  env: process.env,
  home: homedir(),
  directories: (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] } },
  modified: (file) => { try { return statSync(file).mtimeMs } catch { return 0 } },
  exists: (file) => {
    try {
      accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  },
}

// Where an executor's CLI is installed on this machine, if anywhere: the usual
// install locations first, then PATH.
export function findExecutor(name: ExecutorName, machine: Machine = thisMachine): { binary: string; runtime?: string } | null {
  const win = machine.platform === 'win32'
  const p = win ? path.win32 : path.posix
  const { env, home } = machine
  const local = env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local')
  const roaming = env.APPDATA ?? p.join(home, 'AppData', 'Roaming')
  if (name === 'zcode') {
    // ZCode's CLI is a script run by the ZCode app binary in node mode.
    const apps = win
      ? [p.join(local, 'Programs', 'ZCode'), p.join(env.ProgramFiles ?? 'C:\\Program Files', 'ZCode')].map((dir) => ({
        binary: p.join(dir, 'resources', 'glm', 'zcode.cjs'), runtime: p.join(dir, 'ZCode.exe'),
      }))
      : [{ binary: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', runtime: '/Applications/ZCode.app/Contents/MacOS/ZCode' }]
    return apps.find((app) => machine.exists(app.binary) && machine.exists(app.runtime)) ?? null
  }
  if (win && name === 'codex') {
    const root = p.join(local, 'OpenAI', 'Codex', 'bin')
    const candidates = (machine.directories?.(root) ?? []).map((dir) => p.join(root, dir, 'codex.exe')).filter(machine.exists)
      .sort((a, b) => (machine.modified?.(b) ?? 0) - (machine.modified?.(a) ?? 0) || a.localeCompare(b))
    const desktop = candidates[0] ?? (machine.exists(p.join(root, 'codex.exe')) ? p.join(root, 'codex.exe') : undefined)
    if (desktop) return { binary: desktop }
  }
  const places = win
    ? name === 'claude'
      ? [p.join(home, '.local', 'bin', 'claude.exe'), p.join(roaming, 'npm', 'claude.cmd')]
      : [p.join(local, 'Programs', 'Codex', 'codex.exe'), p.join(roaming, 'npm', 'codex.cmd')]
    : name === 'claude'
      ? [p.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', p.join(home, '.claude', 'local', 'claude')]
      : ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/Applications/Codex.app/Contents/Resources/codex',
        '/opt/homebrew/bin/codex', '/usr/local/bin/codex', p.join(home, '.local', 'bin', 'codex')]
  const found = places.find(machine.exists) ?? onPath(name, machine)
  return found ? { binary: found } : null
}

// Follow a running desktop CLI first; otherwise scan versioned cache folders.
export async function detectExecutor(name: ExecutorName): Promise<{ binary: string; runtime?: string } | null> {
  if (process.platform === 'win32' && name === 'codex') {
    const root = path.win32.join(process.env.LOCALAPPDATA ?? path.win32.join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin') + '\\'
    const active = await new Promise<string[]>((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; @(Get-Process codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique) | ConvertTo-Json -Compress'],
        { timeout: 3_000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
          try { resolve(error || !stdout.trim() ? [] : [JSON.parse(stdout)].flat()) } catch { resolve([]) }
        })
    })
    const binary = active.find((file) => typeof file === 'string' && file.toLowerCase().startsWith(root.toLowerCase()) && path.win32.basename(file).toLowerCase() === 'codex.exe' && thisMachine.exists(file))
    if (binary) return { binary }
  }
  return findExecutor(name)
}

// A command on PATH, with Windows' executable extensions.
function onPath(command: string, machine: Machine): string | null {
  const win = machine.platform === 'win32'
  const p = win ? path.win32 : path.posix
  const dirs = (machine.env.PATH ?? machine.env.Path ?? '').split(win ? ';' : ':').filter(Boolean)
  const names = win ? ['.exe', '.cmd', '.bat'].map((ext) => command + ext) : [command]
  for (const dir of dirs) for (const name of names) if (machine.exists(p.join(dir, name))) return p.join(dir, name)
  return null
}

