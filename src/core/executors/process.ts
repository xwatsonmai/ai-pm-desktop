import { execFile, execFileSync, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'

// How to start a program with arguments. npm installs CLIs on Windows as .cmd
// wrappers, which only cmd.exe can run; their arguments then need cmd.exe's
// escaping (as cross-spawn does it). Prompts never go this way: they are passed
// on stdin, because cmd.exe cannot carry line breaks in an argument.
export function commandLine(binary: string, args: string[], platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) return { file: binary, args, verbatim: false }
  const line = [escapeCommand(binary), ...args.map((arg) => escapeArgument(arg, true))].join(' ')
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g
const escapeCommand = (command: string) => command.replace(CMD_META, '^$1')

function escapeArgument(arg: string, doubleEscape: boolean): string {
  // Backslashes before a quote and at the end are doubled, quotes escaped, the
  // whole quoted, then cmd.exe metacharacters escaped (twice through an npm shim).
  let value = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  value = `"${value}"`.replace(CMD_META, '^$1')
  return doubleEscape ? value.replace(CMD_META, '^$1') : value
}

// A start token distinguishes our process from a later one that reuses the pid.
export function processStartToken(pid: number): string | null {
  if (!pid) return null
  if (process.platform === 'win32') return windowsStartTime(pid)
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
  if (process.platform === 'win32') return windowsLiveness(pid, token)
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

// Windows: the process's creation time, from PowerShell.
function windowsStartTime(pid: number): string | null {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim()
    return /^\d+$/.test(out) ? out : null
  } catch {
    return null
  }
}

// PowerShell is slow to start, so a confirmed start time is trusted for a while.
const windowsChecked = new Map<number, { token: string; at: number }>()

function windowsLiveness(pid: number, token: string | null): Liveness {
  if (!token) return 'alive'
  const seen = windowsChecked.get(pid)
  if (seen?.token === token && Date.now() - seen.at < 60_000) return 'alive'
  const now = windowsStartTime(pid)
  if (now === null) return 'unknown'
  if (now !== token) return 'dead' // pid reused
  windowsChecked.set(pid, { token, at: Date.now() })
  return 'alive'
}

// The child gets its own process group and writes straight to files, so it keeps
// running and its output stays readable if the client restarts. `stdinPath`
// feeds it a file, such as the prompt.
export function spawnDetached(binary: string, args: string[], options: { cwd: string; logPath: string; errPath: string; env?: NodeJS.ProcessEnv; stdinPath?: string }) {
  const out = openSync(options.logPath, 'a')
  const err = openSync(options.errPath, 'a')
  const input = options.stdinPath ? openSync(options.stdinPath, 'r') : 'ignore'
  try {
    const command = commandLine(binary, args)
    const child = spawn(command.file, command.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: [input, out, err],
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
    })
    if (!child.pid) throw new Error('spawn_failed: ' + binary)
    child.on('error', () => {})
    child.unref()
    return { pid: child.pid, startToken: processStartToken(child.pid) }
  } finally {
    closeSync(out)
    closeSync(err)
    if (typeof input === 'number') closeSync(input)
  }
}

// Runs a program once and returns its standard output (e.g. `--version`).
export function runOnce(binary: string, args: string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<string> {
  const command = commandLine(binary, args)
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, { timeout: options.timeoutMs, env: options.env, windowsHide: true, windowsVerbatimArguments: command.verbatim },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())))
  })
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
