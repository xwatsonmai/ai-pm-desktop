import { Check, Copy, FileDiff, FileText, FlaskConical, FolderOpen, Hand, MessageSquareReply, Play, RotateCw, Rocket, ScrollText, Undo2, X } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
import type { Route, Snapshot, TaskView } from '../../shared/api.js'
import { api, command } from '../api.js'
import { BusinessForm, PlanBody } from '../components/PlanForm.js'
import { Badge, Button, Empty, PageHeader, Section, TextAction, useRun } from '../components/ui.js'
import { KIND_LABEL, groupNeeds, missingAnswers, shortSha, STAGE_LABEL, stateLabel, stateTone, timeAgo, type Answers } from '../model.js'

type Go = (route: Route) => void

function Meta({ parts }: { parts: ReactNode[] }) {
  return (
    <div className="meta">
      {parts.filter(Boolean).map((part, i) => <Fragment key={i}>{i > 0 && <span className="sep">·</span>}{part}</Fragment>)}
    </div>
  )
}

function Card({ task, go, children, actions, select }: { task: TaskView; go: Go; children?: ReactNode; actions?: ReactNode; select?: ReactNode }) {
  return (
    <article className="card">
      <header className="card-head">
        {select}
        <div className="card-title-block">
          <button className="link card-title" onClick={() => go({ page: 'task', key: task.key })}>
            {task.kind === 'batch' && task.members.length === 1 ? `${STAGE_LABEL[task.stage]} · ${task.members[0].title}` : task.title}
          </button>
          <Meta parts={[
            KIND_LABEL[task.kind],
            task.kind === 'batch' ? `${task.members.length} 个需求` : task.platformId,
            STAGE_LABEL[task.stage],
            timeAgo(task.updatedAt),
          ]} />
        </div>
        <Badge tone={stateTone(task)} dot>{stateLabel(task)}</Badge>
      </header>
      {children && <div className="card-body">{children}</div>}
      {actions && <footer className="card-actions">{actions}</footer>}
    </article>
  )
}

function PlanCard({ task, go }: { task: TaskView; go: Go }) {
  const run = useRun()
  // Recommended options are marked, never preselected.
  const [answers, setAnswers] = useState<Answers>({})
  const plan = task.plan
  if (!plan) return <Card task={task} go={go}><p className="summary">{task.detail}</p></Card>
  const missing = missingAnswers(plan, answers)
  return (
    <Card
      task={task}
      go={go}
      actions={
        <>
          <Button kind="primary" icon={<Play size={14} />} disabled={missing.length > 0}
            title={missing.length ? '还有必填问题：' + missing.join('、') : undefined}
            onClick={() => run(command('confirmPlan', task.key, answers), '已确认方案，开始开发')}>
            确认方案并开始开发
          </Button>
          <TextAction label="提修改意见" icon={<MessageSquareReply size={14} />} submitLabel="发给 Agent 修订" required placeholder="对方案的意见，Agent 会在同一会话里修订"
            onSubmit={(text) => run(command('revisePlan', task.key, text), '已发回修订')} />
          <TextAction label="关闭需求" kind="ghost" icon={<X size={14} />} submitLabel="确认关闭" required placeholder="关闭原因，会原样提交到平台"
            onSubmit={(text) => run(command('closeRequirement', task.key, text, false), '已提交关闭')} />
          {missing.length > 0 && <span className="hint">还有 {missing.length} 个必填问题</span>}
        </>
      }
    >
      <p className="summary">{plan.summary}</p>
      <button className="link requirement-link" onClick={() => go({ page: 'task', key: task.key, tab: 'requirement' })}>
        <FileText size={14} />对照需求原文
      </button>
      <BusinessForm plan={plan} answers={answers} onChange={setAnswers} />
      <PlanBody plan={plan} />
    </Card>
  )
}

function QuestionCard({ task, go }: { task: TaskView; go: Go }) {
  const run = useRun()
  const [reply, setReply] = useState('')
  return (
    <Card
      task={task}
      go={go}
      actions={
        <>
          <Button kind="primary" icon={<MessageSquareReply size={14} />} disabled={!reply.trim()} onClick={async () => {
            if (await run(command('answer', task.key, reply.trim()), '已回复，Agent 继续执行')) setReply('')
          }}>回复并继续</Button>
          <Button icon={<Hand size={14} />} onClick={() => run(command('takeOver', task.key), '已接管')}>接管</Button>
        </>
      }
    >
      <pre className="prose quote">{task.detail}</pre>
      <textarea rows={3} value={reply} placeholder="回复 Agent，例如提供账号、环境或你的取舍" onChange={(e) => setReply(e.target.value)} />
    </Card>
  )
}

function ReadyFacts({ task }: { task: TaskView }) {
  const release = task.reason === 'ready_to_release'
  const sha = release ? task.submittedSha ?? task.dev?.sha : task.dev?.sha
  return (
    <>
      <p className="summary">{task.dev?.summary ?? task.detail}</p>
      <dl className="facts">
        {sha && <><dt>提交</dt><dd><code>{shortSha(sha)}</code> <span className="muted">{task.branch}</span></dd></>}
        {task.dev?.tests && <><dt>测试</dt><dd>{task.dev.tests}</dd></>}
        {task.dev?.limitations && <><dt>未验证</dt><dd>{task.dev.limitations}</dd></>}
      </dl>
    </>
  )
}

function ReadyCard({ task, go, selected, toggle }: { task: TaskView; go: Go; selected: boolean; toggle: () => void }) {
  const run = useRun()
  const release = task.reason === 'ready_to_release'
  return (
    <Card
      task={task}
      go={go}
      select={<input type="checkbox" className="select" checked={selected} onChange={toggle} aria-label="选择" />}
      actions={
        <>
          <Button small icon={<FileDiff size={13} />} onClick={() => go({ page: 'task', key: task.key, tab: 'diff' })}>查看改动</Button>
          {release ? (
            <TextAction label="退回开发" icon={<Undo2 size={13} />} kind="ghost" required submitLabel="退回" placeholder="退回原因，会提交到平台并交给原开发会话"
              onSubmit={(text) => run(command('rework', task.key, text), '已退回开发')} />
          ) : (
            <TextAction label="再改一下" icon={<MessageSquareReply size={13} />} kind="ghost" required submitLabel="发给 Agent" placeholder="修改意见，Agent 会在原开发会话里继续"
              onSubmit={(text) => run(command('requestChanges', task.key, text), '已发给 Agent')} />
          )}
        </>
      }
    >
      <ReadyFacts task={task} />
    </Card>
  )
}

function ReleaseFailedCard({ task, go }: { task: TaskView; go: Go }) {
  const run = useRun()
  return (
    <Card
      task={task}
      go={go}
      actions={
        <>
          <Button kind="primary" icon={<Play size={14} />} title="你看过上面的问题，认为可以接受：Agent 不会再因为这些问题停下，接着把发布做完"
            onClick={() => run(command('continueRelease', task.key), '已在原发布会话里继续')}>继续发布</Button>
          <TextAction label="补充说明后继续" icon={<MessageSquareReply size={14} />} required submitLabel="继续发布" placeholder="告诉发布 Agent 怎么处理，例如：迁移 109 先不要执行"
            onSubmit={(text) => run(command('continueRelease', task.key, text), '已在原发布会话里继续')} />
          {task.stage === 'test_release' && (
            <TextAction label="交给开发修复" icon={<Undo2 size={14} />} required submitLabel="退回开发" placeholder="需要开发修复的问题"
              onSubmit={(text) => run(command('sendBackToDev', task.key, text), '已交给开发')} />
          )}
          <TextAction label="人工确认已完成" icon={<Check size={14} />} required submitLabel="确认并登记" placeholder="你核实过的情况，会写进平台记录"
            onSubmit={(text) => run(command('markReleased', task.key, text), '已登记到平台')} />
          <Button kind="ghost" icon={<X size={14} />} onClick={() => run(command('abandonBatch', task.key), '已放弃本次发布')}>放弃本次</Button>
        </>
      }
    >
      <pre className="prose quote danger">{task.detail}</pre>
      {task.members.length > 1 && (
        <div className="members">
          {task.members.map((m) => <button key={m.key} className="chip" onClick={() => go({ page: 'task', key: m.key })}>{m.title}</button>)}
        </div>
      )}
    </Card>
  )
}

function ProblemCard({ task, go }: { task: TaskView; go: Go }) {
  const run = useRun()
  return (
    <Card
      task={task}
      go={go}
      actions={
        <>
          <Button kind="primary" icon={<RotateCw size={14} />} onClick={() => run(command('retry', task.key), '已重试')}>重试</Button>
          <Button icon={<ScrollText size={14} />} onClick={() => go({ page: 'task', key: task.key, tab: 'log' })}>查看日志</Button>
          <Button kind="ghost" icon={<Hand size={14} />} onClick={() => run(command('takeOver', task.key), '已接管')}>接管</Button>
        </>
      }
    >
      <pre className="prose quote danger">{task.detail}</pre>
    </Card>
  )
}

export function TakeoverBox({ task }: { task: TaskView }) {
  if (!task.takeover) return <p className="hint">这个任务还没有会话，可以直接在工作区里修改。</p>
  return (
    <div className="takeover">
      <div className="hint">在终端里继续这个会话：</div>
      <div className="copy-row">
        <code className="copy-text">{task.takeover.command}</code>
        <Button small icon={<Copy size={13} />} onClick={() => api.copy(task.takeover!.command)}>复制</Button>
        <Button small icon={<FolderOpen size={13} />} onClick={() => api.openPath(task.takeover!.cwd)}>打开工作区</Button>
      </div>
    </div>
  )
}

function TakenOverCard({ task, go }: { task: TaskView; go: Go }) {
  const run = useRun()
  return (
    <Card task={task} go={go} actions={<Button kind="primary" icon={<Play size={14} />} onClick={() => run(command('handBack', task.key), '已交还自动化')}>交还自动化</Button>}>
      <TakeoverBox task={task} />
    </Card>
  )
}

// The card for one task's needs_you reason. On the detail page a ready card acts
// on that single task instead of joining a selection.
export function NeedsCard({ task, go }: { task: TaskView; go: Go }) {
  const run = useRun()
  switch (task.reason) {
    case 'plan_confirm': return <PlanCard task={task} go={go} />
    case 'agent_question':
    case 'merge_failed': return <QuestionCard task={task} go={go} />
    case 'release_failed': return <ReleaseFailedCard task={task} go={go} />
    case 'taken_over': return <TakenOverCard task={task} go={go} />
    case 'ready_to_test':
    case 'ready_to_release': {
      const release = task.reason === 'ready_to_release'
      return (
        <Card task={task} go={go} actions={
          <>
            <Button kind="primary" icon={release ? <Rocket size={14} /> : <FlaskConical size={14} />}
              onClick={() => run(command(release ? 'release' : 'submitTest', [task.key]), release ? '已开始上线' : '已开始提测')}>
              {release ? '上线' : '提测'}
            </Button>
            {release ? (
              <TextAction label="退回开发" icon={<Undo2 size={14} />} required submitLabel="退回" placeholder="退回原因" onSubmit={(text) => run(command('rework', task.key, text), '已退回开发')} />
            ) : (
              <TextAction label="再改一下" icon={<MessageSquareReply size={14} />} required submitLabel="发给 Agent" placeholder="修改意见" onSubmit={(text) => run(command('requestChanges', task.key, text), '已发给 Agent')} />
            )}
          </>
        }>
          <ReadyFacts task={task} />
        </Card>
      )
    }
    default: return <ProblemCard task={task} go={go} />
  }
}

function SelectionBar({ reason, tasks, selected, setSelected }: { reason: string; tasks: TaskView[]; selected: Set<string>; setSelected: (s: Set<string>) => void }) {
  const run = useRun()
  const keys = tasks.filter((t) => selected.has(t.key)).map((t) => t.key)
  const release = reason === 'ready_to_release'
  return (
    <div className="selection-bar">
      <label className="row">
        <input type="checkbox" checked={keys.length === tasks.length} onChange={() => setSelected(new Set(keys.length === tasks.length ? [] : tasks.map((t) => t.key)))} />
        全选
      </label>
      <span className="hint grow">已选 {keys.length} / {tasks.length}</span>
      <Button kind="primary" icon={release ? <Rocket size={14} /> : <FlaskConical size={14} />} disabled={!keys.length} onClick={async () => {
        if (await run(command(release ? 'release' : 'submitTest', keys), release ? '已开始上线' : '已开始提测')) setSelected(new Set())
      }}>
        {release ? `上线 ${keys.length} 项` : `提测 ${keys.length} 项`}
      </Button>
    </div>
  )
}

export function NeedsYou({ snapshot, go }: { snapshot: Snapshot; go: Go }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const groups = groupNeeds(snapshot.tasks)
  const total = groups.reduce((n, g) => n + g.tasks.length, 0)
  const running = snapshot.tasks.filter((t) => t.status === 'running').length
  const subtitle = [total ? `${total} 件事等你决定` : null, running ? `${running} 个任务正在运行` : null].filter(Boolean).join('，')
  if (!groups.length) {
    return (
      <div className="page">
        <Empty title="一切就绪" icon={<Check size={24} />}>{running ? `有 ${running} 个任务正在运行，需要你时会通知你。` : '没有需要你处理的事，有新情况时会通知你。'}</Empty>
      </div>
    )
  }
  const toggle = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelected(next)
  }
  return (
    <div className="page">
      <PageHeader title="待你处理" subtitle={subtitle} />
      {groups.map((group) => (
        <Section key={group.reason} title={group.title} count={group.tasks.length}>
          {(group.reason === 'ready_to_test' || group.reason === 'ready_to_release') && (
            <SelectionBar reason={group.reason} tasks={group.tasks} selected={selected} setSelected={setSelected} />
          )}
          <div className="cards">
            {group.tasks.map((task) => (group.reason === 'ready_to_test' || group.reason === 'ready_to_release')
              ? <ReadyCard key={task.key} task={task} go={go} selected={selected.has(task.key)} toggle={() => toggle(task.key)} />
              : <NeedsCard key={task.key} task={task} go={go} />)}
          </div>
        </Section>
      ))}
    </div>
  )
}
