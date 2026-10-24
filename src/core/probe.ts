import { trimContext } from './flows/prompts.js'
import { McpPlatform, ReadOnlyPlatform, type TokenProvider } from './platform/client.js'
import { contractProblem } from './platform/contract.js'
import type { Settings } from './types.js'
import { originUrl, repositoryIdentity } from './workspace.js'

export interface ProbeStep {
  step: string
  ok: boolean
  detail: string
}

const size = (value: unknown) => `${Math.round(JSON.stringify(value ?? null).length / 1024)}KB`

// Read-only connection test against a real platform: login, binding, error
// codes, work list and subscription. Every write is refused by ReadOnlyPlatform before it is sent.
export async function probe(settings: Settings, tokens: TokenProvider, listenMs = 15_000): Promise<ProbeStep[]> {
  const steps: ProbeStep[] = []
  const record = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail })
  const platform = new ReadOnlyPlatform(new McpPlatform(settings.mcpUrl, settings.resourceUri, tokens, 30_000, settings.protocolVersion))
  try {
    try {
      await tokens.get()
      record('登录', true, '令牌可用')
    } catch (error) {
      record('登录', false, (error as Error).message)
      return steps
    }

    try {
      const context = await platform.call('project_get_context', {})
      const project = context.project ?? {}
      const expected = repositoryIdentity(settings.repository)
      const sameProject = project.id === settings.projectId
      const sameRepository = repositoryIdentity(project.repository ?? '') === expected
      record('project_get_context', sameProject && sameRepository,
        `项目 ${project.id}${sameProject ? '' : '（配置是 ' + settings.projectId + '）'}；仓库${sameRepository ? '一致' : '不一致：' + project.repository}`)
    } catch (error) {
      record('project_get_context', false, (error as Error).message)
    }

    try {
      const problem = await contractProblem(platform)
      record('错误码', !problem, problem ?? '平台返回结构化错误码，可以开启接单')
    } catch (error) {
      record('错误码', false, '暂时无法确认：' + (error as Error).message)
    }

    try {
      const origin = await originUrl(settings.repoPath)
      const same = repositoryIdentity(origin) === repositoryIdentity(settings.repository)
      record('本地仓库', same, same ? 'origin 与平台仓库一致' : `origin 是 ${origin}`)
    } catch (error) {
      record('本地仓库', false, (error as Error).message)
    }

    try {
      const work = await platform.call('work_list', {})
      const count = (items: any[] = []) => {
        const byStatus: Record<string, number> = {}
        for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
        return Object.entries(byStatus).map(([status, n]) => `${status} ${n}`).join('，') || '无'
      }
      const foreign = [...(work.tasks ?? []), ...(work.collaborations ?? [])].filter((t: any) => t.project_id && t.project_id !== settings.projectId)
      record('work_list', foreign.length === 0, `需求：${count(work.tasks)}；协同：${count(work.collaborations)}${foreign.length ? `；${foreign.length} 条属于其他项目` : ''}`)
      const sample = (work.tasks ?? [])[0]
      if (sample) {
        const raw = await platform.call('task_get_context', { task_id: sample.id })
        const keys = Object.keys(raw).map((k) => `${k} ${size(raw[k])}`).join('，')
        record('task_get_context', true, `${sample.id}：原始 ${size(raw)}（${keys}）；交给 agent 的部分 ${size(trimContext(raw))}`)
      }
    } catch (error) {
      record('work_list', false, (error as Error).message)
    }

    const controller = new AbortController()
    let acknowledged = false
    let updates = 0
    const timer = setTimeout(() => controller.abort(), listenMs)
    try {
      await platform.listen({ onAck: () => (acknowledged = true), onUpdate: () => updates++ }, controller.signal)
      record('订阅', acknowledged, acknowledged ? `已确认，${listenMs / 1000} 秒内收到 ${updates} 条更新` : '连接结束但没有收到确认')
    } catch (error) {
      record('订阅', false, (error as Error).message)
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await platform.close()
  }
  return steps
}
