import { createContext, useContext, useState } from 'react'
import { ScanEye } from 'lucide-react'
import type { ExecutorName, ReviewItem, ReviewRound } from '../../core/types.js'
import type { Snapshot, TaskView } from '../../shared/api.js'
import { executorLabel } from '../../shared/labels.js'
import { useWorkspaceApi } from '../api.js'
import { formatTime, shortSha } from '../model.js'
import { Markdown } from './Markdown.js'
import { Badge, Button, Collapsible, useRun } from './ui.js'

// Configured executors with enablement for the selected project workspace.
export const ExecutorsContext = createContext<Snapshot['executors']>([])

export const SEVERITY: Record<ReviewItem['severity'], { label: string; tone: 'danger' | 'warn' | 'muted' }> = {
  must: { label: '必须修', tone: 'danger' },
  should: { label: '建议修', tone: 'warn' },
  optional: { label: '可选', tone: 'muted' },
}

const DECISION: Record<string, string> = { fix: '已返回开发修复', rereview: '补充意见后重新评审', skip: '没有修改，直接提测' }

// The items a user would fix unless they decide otherwise.
export const defaultChoice = (round: ReviewRound) => new Set(round.items.filter((i) => i.severity !== 'optional').map((i) => i.id))

// One review: who reviewed which commit, the fix list, and the full document.
// With `chosen`, each item has a box to tick for fixing.
export function ReviewRoundView({ round, chosen, toggle, open = false }: {
  round: ReviewRound; chosen?: Set<string>; toggle?: (id: string) => void; open?: boolean
}) {
  return (
    <div className="review">
      <div className="review-meta">
        <Badge tone={round.verdict === 'pass' ? 'ok' : 'warn'} dot>{round.verdict === 'pass' ? '没有发现需要修的问题' : `${round.items.length} 个问题`}</Badge>
        <span className="hint">
          第 {round.round} 轮 · {executorLabel(round.executor)}{round.model ? ` · ${round.model}` : ''} · 提交 <code>{shortSha(round.sha)}</code> · {formatTime(round.at)}
        </span>
      </div>
      <p className="summary">{round.summary}</p>
      {round.items.length > 0 && (
        <ul className="review-items">
          {round.items.map((item) => (
            <li key={item.id}>
              <label className={chosen ? 'review-item selectable' : 'review-item'}>
                {chosen && <input type="checkbox" checked={chosen.has(item.id)} onChange={() => toggle?.(item.id)} />}
                <div>
                  <div className="review-item-head">
                    <Badge tone={SEVERITY[item.severity].tone}>{SEVERITY[item.severity].label}</Badge>
                    <strong>{item.id} · {item.title}</strong>
                    <code className="muted">{item.location}</code>
                  </div>
                  <p>{item.problem}</p>
                  <p className="muted">改法：{item.suggestion}</p>
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}
      {round.fixPlan.trim() && <Collapsible title="修复方案" open={open}><Markdown text={round.fixPlan} /></Collapsible>}
      <Collapsible title="评审文档" open={open}><Markdown text={round.document} /></Collapsible>
      {round.decision && (
        <p className="hint">
          你的处理：{DECISION[round.decision.kind]}
          {round.decision.items?.length ? `（${round.decision.items.join('、')}）` : ''}
          {round.decision.note ? `；${round.decision.note}` : ''} · {formatTime(round.decision.at)}
        </p>
      )}
    </div>
  )
}

// Choosing a reviewer instead of 提测. Another executor by default for a second
// pair of eyes; the last reviewer when there is one, so it rechecks its own findings.
export function StartReview({ task }: { task: TaskView }) {
  const { command } = useWorkspaceApi()
  const run = useRun()
  const executors = useContext(ExecutorsContext).filter((e) => e.configured && e.enabled)
  const fallback = task.reviewer ?? executors.find((e) => e.name !== task.executor)?.name ?? task.executor
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<ExecutorName>(fallback)
  if (!executors.length) return null
  if (!open) return <Button icon={<ScanEye size={14} />} onClick={() => setOpen(true)}>AI 评审</Button>
  const chosen = executors.find((e) => e.name === choice) ?? executors[0]
  const recheck = task.reviewer === chosen.name && task.reviews.length > 0
  return (
    <span className="row review-start">
      <select value={chosen.name} onChange={(e) => setChoice(e.target.value as ExecutorName)}>
        {executors.map((e) => (
          <option key={e.name} value={e.name} disabled={e.healthy === false}>
            {executorLabel(e.name)} · {e.expertModel ? `专家模型 ${e.expertModel}` : '默认模型'}{e.healthy === false ? '（不可用）' : ''}
          </option>
        ))}
      </select>
      <Button kind="primary" icon={<ScanEye size={14} />} onClick={() => run(command('startReview', task.key, chosen.name), '已开始评审')}>
        {recheck ? '复查' : '开始评审'}
      </Button>
      <Button kind="ghost" onClick={() => setOpen(false)}>取消</Button>
      <span className="hint">{recheck ? '在原评审会话里复查上一轮的问题' : '评审不改代码，评审期间不能提测'}</span>
    </span>
  )
}
