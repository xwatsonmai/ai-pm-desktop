import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export interface Machine {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
  exists: (file: string) => boolean
  directories?: (dir: string) => string[]
  modified?: (file: string) => number
}

export const thisMachine: Machine = {
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

// Desktop updates replace these versioned CLI folders. Only follow that managed
// installation when the configured executable has disappeared; custom CLIs stay explicit.
function desktopRoot(machine: Machine): string {
  return path.win32.join(machine.env.LOCALAPPDATA ?? path.win32.join(machine.home, 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin')
}

export function findDesktopCodex(machine: Machine = thisMachine): string | undefined {
  if (machine.platform !== 'win32') return undefined
  const root = desktopRoot(machine)
  const candidates = (machine.directories?.(root) ?? []).map((dir) => path.win32.join(root, dir, 'codex.exe')).filter(machine.exists)
    .sort((a, b) => (machine.modified?.(b) ?? 0) - (machine.modified?.(a) ?? 0) || a.localeCompare(b))
  const unversioned = path.win32.join(root, 'codex.exe')
  return candidates[0] ?? (machine.exists(unversioned) ? unversioned : undefined)
}

export function resolveCodexBinary(binary: string, machine: Machine = thisMachine): string {
  if (machine.platform !== 'win32' || machine.exists(binary)) return binary
  const relative = path.win32.relative(desktopRoot(machine), binary).split(path.win32.sep)
  const managed = relative.length === 2 && relative[0] !== '..' && relative[0] !== '.' && relative[1].toLowerCase() === 'codex.exe'
  return managed ? findDesktopCodex(machine) ?? binary : binary
}
