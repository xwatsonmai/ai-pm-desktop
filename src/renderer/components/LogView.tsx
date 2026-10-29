import { Fragment, useEffect, useRef, useState } from 'react'
import type { LogEntry, RunView } from '../../shared/api.js'
import { useWorkspaceApi } from '../api.js'
import { STAGE_LABEL, formatTime } from '../model.js'
import { PURPOSE_LABEL } from '../../shared/labels.js'
import { mergeEntries } from '../../shared/log.js'
import { Badge } from './ui.js'

const RESULT_LABELS: Record<string, string> = {
  status: '状态', summary: '摘要', sha: '提交', tests: '测试', limitations: '未验证', message: '说明', outcome: '结果',
  deployed_sha: '部署版本', environment: '环境', verification: '验证', plan: '步骤', risks: '风险', decision: '决定', body: '说明',
}

function Output({ text }: { text: string }) {
  const lines = text.split('\n')
  const [open, setOpen] = useState(lines.length <= 6)
  return (
    <>
      <pre className="tool-output">{open ? text : lines.slice(0, 6).join('\n')}</pre>
      {lines.length > 6 && (
        <button className="tool-toggle" onClick={() => setOpen(!open)}>{open ? '收起' : `展开其余 ${lines.length - 6} 行`}</button>
      )}
    </>
  )
}

// The final structured result: readable fields first, the rest as JSON.
function Result({ value }: { value: Record<string, unknown> }) {
  const simple = Object.entries(value).filter(([, v]) => typeof v === 'string' && v)
  const complex = Object.entries(value).filter(([, v]) => typeof v === 'object' && v && (!Array.isArray(v) || v.length))
  return (
    <div className="log-result">
      <div className="log-result-head">结构化结果</div>
      <dl className="facts">
        {simple.map(([k, v]) => (
          <Fragment key={k}><dt>{RESULT_LABELS[k] ?? k}</dt><dd>{k === 'sha' || k === 'deployed_sha' ? <code>{String(v)}</code> : String(v)}</dd></Fragment>
        ))}
        {complex.map(([k, v]) => (
          <Fragment key={k}><dt>{RESULT_LABELS[k] ?? k}</dt><dd><code>{JSON.stringify(v, null, 2)}</code></dd></Fragment>
        ))}
      </dl>
    </div>
  )
}

function Entry({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case 'message': {
      let parsed: unknown = null
      try {
        parsed = entry.text.trim().startsWith('{') ? JSON.parse(entry.text) : null
      } catch {
        parsed = null
      }
      return (
        <div className="log-line">
          <span className="log-bullet" />
          {parsed && typeof parsed === 'object' ? <Result value={parsed as Record<string, unknown>} /> : <pre className="prose">{entry.text}</pre>}
        </div>
      )
    }
    case 'command': {
      const state = entry.running ? 'running' : entry.exitCode && entry.exitCode !== 0 ? 'failed' : ''
      return (
        <div className="log-line">
          <span className={'log-bullet tool ' + state} />
          <div>
            <div className="tool-head">
              <span className="tool-name">运行</span>
              <span className="tool-arg">{entry.text}</span>
              {entry.running && <Badge tone="accent" live>运行中</Badge>}
              {!entry.running && entry.exitCode != null && entry.exitCode !== 0 && <Badge tone="danger">退出码 {entry.exitCode}</Badge>}
            </div>
            {entry.output && <Output text={entry.output} />}
          </div>
        </div>
      )
    }
    case 'files':
      return (
        <div className="log-line">
          <span className="log-bullet files" />
          <div>
            <div className="tool-head"><span className="tool-name">编辑</span></div>
            <pre className="tool-output">{entry.text}</pre>
          </div>
        </div>
      )
    case 'reasoning':
      return (
        <div className="log-line">
          <span className="log-bullet faint" />
          <details className="log-reasoning"><summary>思考过程</summary><pre className="prose">{entry.text}</pre></details>
        </div>
      )
    case 'status':
      return <div className="log-status">{entry.text}</div>
    case 'error':
      return <div className="log-line"><span className="log-bullet tool failed" /><div className="log-error">{entry.text}</div></div>
    default:
      return <div className="log-line"><span className="log-bullet faint" /><div className="log-other"><pre>{entry.text}</pre></div></div>
  }
}

// Follows a run's log while it is running; merges entries that continue earlier ones by id.
function RunLog({ run }: { run: RunView }) {
  const api = useWorkspaceApi()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let offset = 0
    let stopped = false
    let merged: LogEntry[] = []
    setEntries([])
    const pull = async () => {
      while (!stopped) {
        const chunk = await api.runLog(run.id, offset)
        offset = chunk.offset
        if (chunk.entries.length) {
          merged = mergeEntries(merged, chunk.entries)
          const node = box.current
          const nearBottom = !node || node.scrollHeight - node.scrollTop - node.clientHeight < 80
          setEntries(merged)
          if (nearBottom) requestAnimationFrame(() => box.current?.scrollTo({ top: box.current.scrollHeight }))
        }
        if (chunk.done) return
        await new Promise((resolve) => setTimeout(resolve, chunk.entries.length ? 200 : 1_000))
      }
    }
    void pull()
    return () => {
      stopped = true
    }
  }, [run.id, api])
  return (
    <div className="log" ref={box}>
      {entries.length === 0 ? <div className="hint">{run.endedAt ? '这一轮没有输出。' : '等待 Agent 输出…'}</div> : entries.map((e) => <Entry key={e.id} entry={e} />)}
      {run.error && <div className="log-error">{run.error}</div>}
    </div>
  )
}

export function LogView({ runs }: { runs: RunView[] }) {
  const latest = runs[runs.length - 1]
  const [selected, setSelected] = useState<string | null>(latest?.id ?? null)
  const followLatest = useRef(true)
  useEffect(() => {
    // Jump to a new run as it starts, unless the user picked an older one.
    if (followLatest.current && latest) setSelected(latest.id)
  }, [latest?.id])
  if (!runs.length) return <p className="hint">还没有执行记录。</p>
  const run = runs.find((r) => r.id === selected) ?? latest
  return (
    <div className="log-layout">
      <ul className="run-list">
        {[...runs].reverse().map((r) => (
          <li key={r.id}>
            <button className={r.id === run.id ? 'active' : ''} onClick={() => {
              followLatest.current = r.id === latest.id
              setSelected(r.id)
            }}>
              <span className="run-title">
                <span className={'dot ' + (!r.endedAt ? 'dot-live' : r.outcome === 'completed' ? 'dot-ok' : 'dot-bad')} />
                {STAGE_LABEL[r.stage]} · {PURPOSE_LABEL[r.purpose] ?? r.purpose}
              </span>
              <span className="hint">{formatTime(r.startedAt)}{!r.endedAt ? ' · 运行中' : r.outcome === 'interrupted' ? ' · 中断' : r.outcome === 'failed' ? ' · 失败' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
      <RunLog key={run.id} run={run} />
    </div>
  )
}
