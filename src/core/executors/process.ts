import { execFileSync, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'

// A start token distinguishes our process from a later one that reuses the pid.
export function processStartToken(pid: number): string | null {
  if (!pid) return null
  if (process.platform === 'win32') {
    // TODO(P3): read the creation time through PowerShell instead of a bare liveness check.
    try {
      process.kill(pid, 0)
      return 'alive'
    } catch {
      return null
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }).trim()
    if (!out || out.startsWith('Z')) return null
    return out.replace(/^\S+\s+/, '')
  } catch {
    return null
  }
}

export function isAlive(pid: number, token: string | null): boolean {
  const current = processStartToken(pid)
  if (current === null) return false
  return token === null || process.platform === 'win32' || current === token
}

// The child gets its own process group and writes straight to files, so it keeps
// running and its output stays readable if the client restarts.
export function spawnDetached(binary: string, args: string[], options: { cwd: string; logPath: string; errPath: string; env?: NodeJS.ProcessEnv }) {
  const out = openSync(options.logPath, 'a')
  const err = openSync(options.errPath, 'a')
  try {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
    })
    if (!child.pid) throw new Error('spawn_failed: ' + binary)
    child.on('error', () => {})
    child.unref()
    return { pid: child.pid, startToken: processStartToken(child.pid) }
  } finally {
    closeSync(out)
    closeSync(err)
  }
}

export async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 10_000 })
    } catch {
      // Already gone.
    }
    return
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        process.kill(pid, sig)
      } catch {
        // Already gone.
      }
    }
  }
  signal('SIGTERM')
  for (let i = 0; i < 30; i++) {
    if (!processStartToken(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  signal('SIGKILL')
}
