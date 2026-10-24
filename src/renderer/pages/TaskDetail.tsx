import { ChevronLeft, CircleAlert, Cpu, FolderOpen, GitBranch, Hand, Hash, Layers, LogOut, RotateCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Detail, Route } from '../../shared/api.js'
import { api, command } from '../api.js'
import { DiffView } from '../components/DiffView.js'
import { LogView } from '../components/LogView.js'
import { AnswerList, PlanBody } from '../components/PlanForm.js'
import { Requirement } from '../components/Requirement.js'
import { Badge, Button, Empty, TextAction, useRun } from '../components/ui.js'
import { EVENT_LABEL, eventText, KIND_LABEL, STAGE_LABEL, formatTime, platformLabel, shortSha, stateLabel, stateTone } from '../model.js'
import { errorText, toolLabel } from '../../shared/labels.js'
import { NeedsCard } from './NeedsYou.js'

const TABS = [
  { id: 'requirement', label: '需求' },
  { id: 'progress', label: '进度' },
  { id: 'log', label: '日志' },
  { id: 'plan', label: '方案' },
  { id: 'diff', label: '改动' },
]

export function TaskDetail({ taskKey, tab, version, go }: { taskKey: string; tab?: string; version: number; go: (route: Route) => void }) {
  const [detail, setDetail] = useState<Detail | null | undefined>(undefined)
  const [active, setActive] = useState(tab)
  const tabsRef = useRef<HTMLDivElement>(null)
  const run = useRun()
  useEffect(() => setActive(tab), [taskKey, tab])
  // Asked for a tab by a link (e.g. "查看需求原文" on the plan card): bring it into view.
  useEffect(() => {
    if (tab && detail) tabsRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [tab, !!detail])
  useEffect(() => {
    let live = true
    api.detail(taskKey).then((d) => live && setDetail(d))
    return () => {
      live = false
    }
  }, [taskKey, version])
  if (detail === undefined) return <p className="hint page">读取中…</p>
  if (detail === null) return <div className="page"><Empty title="找不到这个任务" /></div>
  const { task } = detail
  const open = !['done', 'closed'].includes(task.status)
  const tabs = TABS.filter((t) => task.kind !== 'batch' || t.id === 'progress' || t.id === 'log')
  // Confirming a plan means weighing it against the requirement, so show that first.
  const current = active ?? (task.reason === 'plan_confirm' ? 'requirement' : 'progress')
  return (
    <div className="page detail">
      <button className="link back" onClick={() => go({ page: 'tasks' })}><ChevronLeft size={15} />全部任务</button>
      <header className="detail-head">
        <div>
          <h1 className="detail-title">{task.title}</h1>
          <div className="detail-meta">
            <span><Layers size={13} />{KIND_LABEL[task.kind]} · {STAGE_LABEL[task.stage]}</span>
            <span><Hash size={13} />{task.kind === 'batch' ? task.platformId.slice(0, 8) : task.platformId}</span>
            <span><Cpu size={13} />{task.executor === 'codex' ? 'Codex' : task.executor}</span>
            {task.branch && <span><GitBranch size={13} /><code>{task.branch}</code></span>}
            {task.platformStatus && <span>平台 · {platformLabel(task.platformStatus)}</span>}
          </div>
        </div>
        <div className="row">
          <Badge tone={stateTone(task)} dot live={task.status === 'running'}>{stateLabel(task)}</Badge>
          {task.failures >= 3 && <Badge tone="danger">异常</Badge>}
        </div>
      </header>

      {task.lastError && (
        <div className="notice notice-danger">
          <CircleAlert size={16} />
          <span style={{ flex: 1 }}>
            最近一次错误：{errorText(task.lastError)}
            {task.retryAt && <span className="hint"> · {formatTime(new Date(task.retryAt).toISOString())} 自动重试</span>}
          </span>
          <Button small icon={<RotateCw size={13} />} onClick={() => run(command('retryNow', task.key), '马上重试')}>立即重试</Button>
        </div>
      )}
      {task.status === 'needs_you' ? <div className="detail-card"><NeedsCard task={task} go={go} /></div>
        : task.detail && <pre className="prose quote">{task.detail}</pre>}
      {task.batch && (
        <div className="notice">
          <Layers size={15} className="muted" />
          <span style={{ flex: 1 }}>这个需求正在一个发布批次里。</span>
          <button className="link" onClick={() => go({ page: 'task', key: task.batch! })}>查看发布批次</button>
        </div>
      )}

      {open && task.kind !== 'batch' && (
        <div className="row actions">
          {task.reason !== 'taken_over' && <Button icon={<Hand size={14} />} onClick={() => run(command('takeOver', task.key), '已接管')}>接管</Button>}
          {task.worktree && <Button icon={<FolderOpen size={14} />} onClick={() => api.openPath(task.worktree!)}>打开工作区</Button>}
          <TextAction label="放弃认领" icon={<LogOut size={14} />} kind="ghost" required submitLabel="确认放弃" placeholder="交接说明：已有成果和下一步，会提交到平台"
            onSubmit={(text) => run(command('releaseClaim', task.key, text), '已提交放弃认领')} />
          {task.kind === 'task' && (
            <TextAction label="关闭需求" icon={<X size={14} />} kind="ghost" required submitLabel="确认关闭" placeholder="关闭原因，会原样提交到平台"
              onSubmit={(text) => run(command('closeRequirement', task.key, text, false), '已提交关闭')} />
          )}
        </div>
      )}

      <div className="tabs" ref={tabsRef}>
        <div className="segmented">
          {tabs.map((t) => <button key={t.id} className={t.id === current ? 'active' : ''} onClick={() => setActive(t.id)}>{t.label}</button>)}
        </div>
      </div>

      {current === 'requirement' && <Requirement requirement={detail.requirement} />}
      {current === 'progress' && (
        <div className="progress">
          {task.kind === 'batch' && task.status !== 'needs_you' && (
            <div className="members">
              {task.members.map((m) => <button key={m.key} className="chip" onClick={() => go({ page: 'task', key: m.key })}>{m.title}</button>)}
            </div>
          )}
          {(task.dev || task.release) && (
            <div className="panel">
              {task.dev && (
                <dl className="facts">
                  <dt>开发结果</dt><dd>{task.dev.summary}</dd>
                  <dt>提交</dt><dd><code>{shortSha(task.dev.sha)}</code></dd>
                  <dt>测试</dt><dd>{task.dev.tests}</dd>
                  {task.dev.limitations && <><dt>未验证</dt><dd>{task.dev.limitations}</dd></>}
                </dl>
              )}
              {task.release && (
                <dl className="facts">
                  <dt>发布结果</dt><dd>{String(task.release.summary ?? '')}</dd>
                  {task.release.environment ? <><dt>环境</dt><dd>{String(task.release.environment)}</dd></> : null}
                  {task.release.verification ? <><dt>验证</dt><dd>{String(task.release.verification)}</dd></> : null}
                </dl>
              )}
            </div>
          )}
          {detail.outbox.length > 0 && (
            <>
              <h3>平台操作</h3>
              <div className="table-wrap">
                <table className="table compact">
                  <tbody>
                    {detail.outbox.map((o) => (
                      <tr key={o.id}>
                        <td title={o.tool}>{toolLabel(o.tool)}</td>
                        <td><Badge tone={o.status === 'done' ? 'ok' : o.status === 'rejected' ? 'danger' : 'warn'} dot>{o.status === 'done' ? '完成' : o.status === 'rejected' ? '被拒绝' : '等待发送'}</Badge></td>
                        <td className="muted">{o.attempts} 次{o.lastError ? ' · ' + errorText(o.lastError) : ''}</td>
                        <td className="muted">{formatTime(o.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <h3>时间线</h3>
          <ul className="timeline">
            {detail.events.map((e, i) => (
              <li key={i} className={e.type === 'you' ? 'mine' : undefined}>
                <span className="time">{formatTime(e.at)}</span>
                <span className="event-type">{EVENT_LABEL[e.type] ?? e.type}</span>
                <span>{eventText(e)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {current === 'log' && <LogView runs={detail.runs} />}
      {current === 'plan' && (task.plan ? (
        <div className="panel">
          <p className="summary">{task.plan.summary}</p>
          {task.planAnswers && <><h3>你的业务选择</h3><AnswerList plan={task.plan} answers={task.planAnswers} /></>}
          <h3>方案</h3>
          <PlanBody plan={task.plan} open />
        </div>
      ) : <p className="hint">还没有方案。</p>)}
      {current === 'diff' && <DiffView taskKey={task.key} refresh={task.updatedAt} />}
    </div>
  )
}
