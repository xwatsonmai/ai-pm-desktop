import { McpPlatform, type TokenProvider } from './client.js'
import { git, repositoryIdentity } from '../workspace.js'
import type { ProjectSettings } from '../types.js'

export interface BindingMetadata {
  name: string
  projectId: string
  mcpUrl: string
  resourceUri: string
  repository: string
  startRef: string
}

export function platformMcpUrl(entry: string): string {
  const url = new URL(entry.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含账号、查询参数的 HTTP 或 HTTPS 平台地址')
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/mcp$/, '') + '/mcp'
  return url.toString()
}

export async function discoverBinding(mcpUrl: string, tokens: TokenProvider): Promise<BindingMetadata> {
  const platform = new McpPlatform(mcpUrl, '', tokens)
  try {
    const { project } = await platform.call('project_get_context', {})
    if (!project || !/^prj_[\w-]+$/.test(project.id) || typeof project.repository !== 'string' || !project.repository.trim()) throw new Error('平台未返回有效的项目信息和仓库地址')
    const uri = `ai-pm://projects/${project.id}/work`
    const resources = await platform.listResources()
    if (!resources.some((r) => r.uri === uri)) throw new Error('平台未提供当前项目的工作订阅资源')
    const branch = typeof project.branch === 'string' ? project.branch.trim().replace(/^refs\/heads\//, '') : ''
    if (!branch || branch.startsWith('-') || /[\s\x00-\x1f]/.test(branch)) throw new Error('平台未返回有效的开发基准分支，请在平台配置后重试')
    return { name: project.name || project.id, projectId: project.id, mcpUrl, resourceUri: uri, repository: project.repository, startRef: 'origin/' + branch }
  } finally {
    await platform.close()
  }
}

export async function checkRepository(settings: Pick<ProjectSettings, 'repoPath' | 'repository' | 'startRef'>): Promise<{ root: string; branch: string }> {
  if (!settings.repoPath.trim() || !settings.startRef.trim() || settings.startRef.startsWith('-')) throw new Error('请选择本地仓库并填写有效的开发起始分支')
  const root = await git(settings.repoPath, ['rev-parse', '--show-toplevel'])
  const origin = await git(root, ['remote', 'get-url', 'origin'])
  if (repositoryIdentity(origin) !== repositoryIdentity(settings.repository)) throw new Error('本地 origin 与平台仓库不一致，请选择对应仓库')
  await git(root, ['check-ref-format', '--allow-onelevel', settings.startRef])
  await git(root, ['rev-parse', '--verify', '--end-of-options', settings.startRef + '^{commit}'])
  return { root, branch: settings.startRef }
}
