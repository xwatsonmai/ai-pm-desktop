import { LayoutList, Search } from 'lucide-react'
import { useState } from 'react'
import type { Route, Snapshot, TaskView } from '../../shared/api.js'
import { Badge, Empty, PageHeader } from '../components/ui.js'
import { displayState, KIND_LABEL, platformLabel, STAGE_LABEL, timeAgo } from '../model.js'
import { executorLabel } from '../../shared/labels.js'

type Filter = { id: string; label: string; match: (t: TaskView, all: TaskView[]) => boolean }

const FILTERS: Filter[] = [
  { id: 'active', label: '进行中', match: (t) => ['queued', 'running', 'waiting', 'needs_you'].includes(t.status) },
  { id: 'needs', label: '待你处理', match: (t, all) => displayState(t, all).needsYou },
  { id: 'done', label: '已完成', match: (t) => t.status === 'done' },
  { id: 'closed', label: '已关闭', match: (t) => t.status === 'closed' },
  { id: 'all', label: '全部', match: () => true },
]

export function Tasks({ snapshot, go }: { snapshot: Snapshot; go: (route: Route) => void }) {
  const [filter, setFilter] = useState('active')
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const many = snapshot.projects.length > 1
  const projectName = (id: string) => snapshot.projects.find((p) => p.id === id)?.name ?? id
  const current = FILTERS.find((f) => f.id === filter)!
  const q = query.trim().toLowerCase()
  const all = snapshot.tasks
  // Release batches show up as the state of their requirements, not as rows.
  const tasks = all.filter((t) => t.kind !== 'batch' && (!project || t.project === project))
  const rows = tasks.filter((t) => current.match(t, all)).filter((t) => !q || t.title.toLowerCase().includes(q) || t.platformId.toLowerCase().includes(q))
  const running = tasks.filter((t) => displayState(t, all).live).length
  return (
    <div className="page">
      <PageHeader title="全部任务" subtitle={`共 ${tasks.length} 个，${running} 个正在运行`} />
      <div className="toolbar">
        <div className="segmented">
          {FILTERS.map((f) => (
            <button key={f.id} className={f.id === filter ? 'active' : ''} onClick={() => setFilter(f.id)}>
              {f.label}<span className="count">{tasks.filter((t) => f.match(t, all)).length}</span>
            </button>
          ))}
        </div>
        {many && (
          <select className="project-filter" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">全部项目</option>
            {snapshot.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <label className="search">
          <Search size={14} />
          <input placeholder="搜索标题或任务 ID" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      {rows.length === 0 ? (
        <Empty title="这里还没有任务" icon={<LayoutList size={22} />}>换个筛选条件试试。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>需求</th>{many && <th>项目</th>}<th>阶段</th><th>状态</th><th>执行器</th><th>平台</th><th>更新</th></tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.key} onClick={() => go({ page: 'task', key: t.key })}>
                  <td>
                    <div className="cell-title">{t.title}</div>
                    <div className="cell-sub">{KIND_LABEL[t.kind]} · {t.platformId}</div>
                  </td>
                  {many && <td className="muted">{projectName(t.project)}</td>}
                  <td>{STAGE_LABEL[t.stage]}</td>
                  <td>
                    <div className="row">
                      {(() => {
                        const state = displayState(t, all)
                        return <Badge tone={state.tone} dot live={state.live}>{state.label}</Badge>
                      })()}
                      {t.failures >= 3 && <Badge tone="danger">异常</Badge>}
                    </div>
                  </td>
                  <td className="muted">{executorLabel(t.executor)}</td>
                  <td className="muted">{platformLabel(t.platformStatus)}</td>
                  <td className="muted">{timeAgo(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
