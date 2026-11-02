import { git, originUrl, repositoryIdentity } from './workspace.js'

// Publish a specific commit, never an implicit current branch or a force push.
// A shared requirement branch may advance while a bug fix is being published;
// a remote descendant is valid too, as long as it contains the promised commit.
export async function pushTaskBranch(repo: string, branch: string, sha: string, repository: string): Promise<string> {
  if (!branch.startsWith('ai-pm/')) throw new Error('自动推送只允许 ai-pm/ 任务分支：' + branch)
  await git(repo, ['check-ref-format', 'refs/heads/' + branch])
  if (repositoryIdentity(await originUrl(repo)) !== repositoryIdentity(repository)) throw new Error('origin 与平台项目仓库不一致，未推送代码')
  const ref = 'refs/heads/' + branch
  const local = await git(repo, ['rev-parse', '--verify', ref])
  await git(repo, ['merge-base', '--is-ancestor', sha, local])
  const visible = async (): Promise<string | null> => {
    const line = await git(repo, ['ls-remote', '--heads', 'origin', ref], 30_000)
    const remote = line.split(/\s+/)[0]
    if (!remote) return null
    if (remote === sha) return remote
    await git(repo, ['fetch', '--quiet', '--no-tags', 'origin', ref], 60_000)
    return await git(repo, ['merge-base', '--is-ancestor', sha, remote]).then(() => remote, () => null)
  }
  const existing = await visible()
  if (existing) return existing
  try {
    // Refuse a parent commit whose changed submodule commits are unpublished.
    await git(repo, ['push', '--porcelain', '--recurse-submodules=check', 'origin', `${sha}:${ref}`], 60_000)
  } catch (error) {
    // A timeout can mean the remote accepted the push. Recheck before retrying.
    const accepted = await visible().catch(() => null)
    if (accepted) return accepted
    throw error
  }
  const remote = await visible()
  if (!remote) throw new Error(`${branch} 推送后远端未包含提交 ${sha}`)
  return remote
}
