import { execFileSync, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'

// A start token distinguishes our process from a later one that reuses the pid.
export function processStartToken(pid: number): string | null {
  if (!pid || process.platform === 'win32') return null // TODO(P3): creation time through PowerShell
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }).trim()
    return out || null
  } catch {
    return null
  }
}

export type Liveness = 'alive' | 'dead' | 'unknown'

// "dead" only on positive evidence. A check that itself fails (ps timing out
// under load, a failed fork) is "unknown", and callers keep waiting.
export function liveness(pid: number, token: string | null): Liveness {
  if (!pid) return 'dead'
  try {
    process.kill(pid, 0)
  } catch (error) {
    // ESRCH: no such process. EPERM: the pid now belongs to another user.
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ESRCH' || code === 'EPERM' ? 'dead' : 'unknown'
  }
  if (process.platform === 'win32') return 'alive'
  let out: string
  try {
    out = execFileSync('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }).trim()
  } catch (error) {
    // ps exits with 1 when the process is gone; anything else says nothing.
    return (error as { status?: number }).status === 1 ? 'dead' : 'unknown'
  }
  if (!out || out.startsWith('Z')) return 'dead'
  if (token && out.replace(/^\S+\s+/, '') !== token) return 'dead' // pid reused
  return 'alive'
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
    if (liveness(pid, null) === 'dead') return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  signal('SIGKILL')
}
