import { LayoutList, Search } from 'lucide-react'
import { useState } from 'react'
import type { Route, Snapshot, TaskView } from '../../shared/api.js'
import { Badge, Empty, PageHeader } from '../components/ui.js'
import { KIND_LABEL, platformLabel, STAGE_LABEL, stateLabel, stateTone, timeAgo } from '../model.js'

const FILTERS: { id: string; label: string; match: (t: TaskView) => boolean }[] = [
  { id: 'active', label: '进行中', match: (t) => ['queued', 'running', 'waiting', 'needs_you'].includes(t.status) },
  { id: 'needs', label: '待你处理', match: (t) => t.status === 'needs_you' },
  { id: 'done', label: '已完成', match: (t) => t.status === 'done' },
  { id: 'closed', label: '已关闭', match: (t) => t.status === 'closed' },
  { id: 'all', label: '全部', match: () => true },
]

export function Tasks({ snapshot, go }: { snapshot: Snapshot; go: (route: Route) => void }) {
  const [filter, setFilter] = useState('active')
  const [query, setQuery] = useState('')
  const current = FILTERS.find((f) => f.id === filter)!
  const q = query.trim().toLowerCase()
  const rows = snapshot.tasks.filter(current.match).filter((t) => !q || t.title.toLowerCase().includes(q) || t.platformId.toLowerCase().includes(q))
  const running = snapshot.tasks.filter((t) => t.status === 'running').length
  return (
    <div className="page">
      <PageHeader title="全部任务" subtitle={`共 ${snapshot.tasks.length} 个，${running} 个正在运行`} />
      <div className="toolbar">
        <div className="segmented">
          {FILTERS.map((f) => (
            <button key={f.id} className={f.id === filter ? 'active' : ''} onClick={() => setFilter(f.id)}>
              {f.label}<span className="count">{snapshot.tasks.filter(f.match).length}</span>
            </button>
          ))}
        </div>
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
              <tr><th>需求</th><th>阶段</th><th>状态</th><th>执行器</th><th>平台</th><th>更新</th></tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.key} onClick={() => go({ page: 'task', key: t.key })}>
                  <td>
                    <div className="cell-title">{t.title}</div>
                    <div className="cell-sub">{KIND_LABEL[t.kind]} · {t.kind === 'batch' ? `${t.members.length} 个需求` : t.platformId}</div>
                  </td>
                  <td>{STAGE_LABEL[t.stage]}</td>
                  <td>
                    <div className="row">
                      <Badge tone={stateTone(t)} dot live={t.status === 'running'}>{stateLabel(t)}</Badge>
                      {t.failures >= 3 && <Badge tone="danger">异常</Badge>}
                    </div>
                  </td>
                  <td className="muted">{t.executor === 'codex' ? 'Codex' : t.executor}</td>
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
