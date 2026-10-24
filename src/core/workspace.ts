import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export class GitError extends Error {}

export function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) fail(new GitError(`git ${args.join(' ')}: ${(stderr || error.message).trim()}`))
      else done(stdout.trim())
    })
  })
}

// host + path of a remote, so SSH and HTTP URLs of one repository compare equal.
export function repositoryIdentity(url: string): string {
  const value = url.trim()
  let host = ''
  let path = value
  if (/^[\w.-]+@[\w.-]+:/.test(value)) {
    host = value.slice(value.indexOf('@') + 1, value.indexOf(':'))
    path = value.slice(value.indexOf(':') + 1)
  } else if (value.includes('://')) {
    const parsed = new URL(value)
    host = parsed.hostname
    path = parsed.protocol === 'file:' ? resolve(decodeURIComponent(parsed.pathname)) : parsed.pathname
  } else {
    path = resolve(value)
  }
  return host + ':' + path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
}

async function fetchIfRemote(repoPath: string, baseRef: string) {
  if (baseRef.startsWith('origin/')) await git(repoPath, ['fetch', '--quiet', 'origin'])
}

// The client's context files must never be committed by an agent.
export async function ensureExcluded(repoPath: string) {
  const common = await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const file = join(common, 'info', 'exclude')
  mkdirSync(join(common, 'info'), { recursive: true })
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!current.split('\n').includes('.ai-pm/')) appendFileSync(file, (current && !current.endsWith('\n') ? '\n' : '') + '.ai-pm/\n')
}

export async function ensureTaskWorktree(options: { repoPath: string; dir: string; branch: string; baseRef: string }): Promise<string> {
  const { repoPath, dir, branch, baseRef } = options
  if (existsSync(dir)) {
    const head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
    if (head === branch) return dir
    throw new GitError(`worktree ${dir} is on ${head || 'an unknown ref'}, expected ${branch}`)
  }
  await fetchIfRemote(repoPath, baseRef)
  const exists = await git(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]).then(() => true, () => false)
  await git(repoPath, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, baseRef])
  await ensureExcluded(repoPath)
  return dir
}

// A detached checkout for release and collaboration runs.
export async function ensureDetachedWorktree(options: { repoPath: string; dir: string; baseRef: string }): Promise<string> {
  const { repoPath, dir, baseRef } = options
  if (existsSync(dir)) return dir
  await fetchIfRemote(repoPath, baseRef)
  await git(repoPath, ['worktree', 'add', '--detach', dir, baseRef])
  await ensureExcluded(repoPath)
  return dir
}

export function writeContext(dir: string, files: Record<string, string>) {
  const target = join(dir, '.ai-pm')
  mkdirSync(target, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(target, name), content)
}

// Where the configured project sits inside its repository, e.g. "server/" or "".
export const repoPrefix = (repoPath: string) => git(repoPath, ['rev-parse', '--show-prefix'])

export const headSha = (dir: string) => git(dir, ['rev-parse', 'HEAD'])
export const isClean = async (dir: string) => (await git(dir, ['status', '--porcelain'])) === ''
export const originUrl = (repoPath: string) => git(repoPath, ['remote', 'get-url', 'origin'])
