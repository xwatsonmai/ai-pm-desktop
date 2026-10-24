import { CircleAlert, Inbox, KeyRound, LayoutList, PauseCircle, Settings as SettingsIcon, Waypoints } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Route, Snapshot } from '../shared/api.js'
import { api, onChanged, onNavigate, setIntake } from './api.js'
import { Button, Toggle, ToastProvider, useRun } from './components/ui.js'
import { NeedsYou } from './pages/NeedsYou.js'
import { Settings } from './pages/Settings.js'
import { TaskDetail } from './pages/TaskDetail.js'
import { Tasks } from './pages/Tasks.js'
import { timeAgo } from './model.js'

function Banners({ snapshot, go }: { snapshot: Snapshot; go: (r: Route) => void }) {
  const run = useRun()
  const { engine, auth } = snapshot
  const banners = []
  if (!snapshot.configured) {
    banners.push(
      <div key="setup" className="banner banner-warn">
        <CircleAlert size={16} /><span className="grow">还没有配置项目。</span>
        <Button small kind="primary" onClick={() => go({ page: 'settings' })}>去设置</Button>
      </div>,
    )
  } else if (auth.mode === 'oauth' && (!auth.loggedIn || engine.authRequired)) {
    banners.push(
      <div key="auth" className="banner banner-warn">
        <KeyRound size={16} />
        <span className="grow">{auth.loggedIn ? 'AI PM 平台的登录已失效。' : '还没有登录 AI PM 平台。'}正在运行的 Agent 不受影响，读写平台已暂停。</span>
        <Button small kind="primary" onClick={() => run(api.login(), '登录成功')}>登录</Button>
      </div>,
    )
  }
  if (engine.bindingError) {
    banners.push(
      <div key="binding" className="banner banner-danger">
        <CircleAlert size={16} /><span className="grow">项目绑定核对失败：{engine.bindingError}。已停止接新需求，请检查设置。</span>
      </div>,
    )
  }
  if (engine.contractError) {
    banners.push(
      <div key="contract" className="banner banner-danger">
        <CircleAlert size={16} /><span className="grow">{engine.contractError}。已停止接新需求，已认领的任务会继续推进。</span>
      </div>,
    )
  }
  if (snapshot.configured && engine.intakePaused) {
    banners.push(
      <div key="paused" className="banner banner-info">
        <PauseCircle size={16} /><span className="grow">已暂停接新需求，已认领的任务会继续推进。</span>
        <Button small onClick={() => run(setIntake(false), '已恢复接单')}>恢复接单</Button>
      </div>,
    )
  }
  return banners.length ? <div className="banners">{banners}</div> : null
}

function Shell() {
  const run = useRun()
  const [route, setRoute] = useState<Route>({ page: 'needs' })
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => {
    api.snapshot().then((s) => {
      setSnapshot(s)
      setVersion((v) => v + 1)
    })
  }, [])
  useEffect(() => {
    refresh()
    const offChanged = onChanged(refresh)
    const offNavigate = onNavigate(setRoute)
    const timer = setInterval(refresh, 5_000) // keeps relative times fresh
    return () => {
      offChanged()
      offNavigate()
      clearInterval(timer)
    }
  }, [refresh])
  useEffect(() => {
    if (snapshot && !snapshot.configured && route.page === 'needs') setRoute({ page: 'settings' })
  }, [snapshot?.configured])
  if (!snapshot) return <div className="loading">正在启动…</div>

  const needs = snapshot.tasks.filter((t) => t.status === 'needs_you').length
  const active = snapshot.tasks.filter((t) => t.kind !== 'batch' && ['queued', 'running', 'waiting', 'needs_you'].includes(t.status)).length
  const running = snapshot.tasks.filter((t) => t.status === 'running').length
  const nav = [
    { route: { page: 'needs' } as Route, label: '待你处理', icon: <Inbox size={16} />, count: needs, hot: true },
    { route: { page: 'tasks' } as Route, label: '全部任务', icon: <LayoutList size={16} />, count: active, hot: false },
    { route: { page: 'settings' } as Route, label: '设置', icon: <SettingsIcon size={16} />, count: 0, hot: false },
  ]
  const current = route.page === 'task' ? 'tasks' : route.page
  const engine = snapshot.engine
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Waypoints size={15} /></span>
          <span className="brand-name">AI PM</span>
        </div>
        <nav className="nav">
          {nav.map((item) => (
            <button key={item.route.page} className={'nav-item' + (current === item.route.page ? ' active' : '')} onClick={() => setRoute(item.route)}>
              {item.icon}
              <span className="nav-label">{item.label}</span>
              {item.count > 0 && <span className={'nav-count' + (item.hot ? ' hot' : '')}>{item.count}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="status-card">
            <div className="status-line">
              <span className={'dot ' + (engine.connected ? 'dot-ok' : engine.running ? 'dot-warn' : '')} />
              {engine.connected ? '已连接平台' : engine.running ? '正在连接…' : '未运行'}
              {engine.lastReconcileAt && <span className="hint">{timeAgo(engine.lastReconcileAt)}</span>}
            </div>
            {snapshot.executors.filter((e) => e.configured).map((e) => (
              <div key={e.name} className="status-line">
                <span className={'dot ' + (e.healthy === false ? 'dot-bad' : running ? 'dot-live' : e.healthy ? 'dot-ok' : '')} />
                {e.name === 'codex' ? 'Codex' : e.name}
                <span className="hint">{e.healthy === false ? '不可用' : running ? `${running} 个运行中` : '空闲'}</span>
              </div>
            ))}
            {snapshot.configured && (
              <div className="status-line">
                <span>接新需求</span>
                <span className="hint"><Toggle on={!engine.intakePaused} label="接新需求" onChange={(on) => run(setIntake(!on), on ? '已恢复接单' : '已暂停接新需求')} /></span>
              </div>
            )}
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="drag-strip" />
        <Banners snapshot={snapshot} go={setRoute} />
        {route.page === 'needs' && <NeedsYou snapshot={snapshot} go={setRoute} />}
        {route.page === 'tasks' && <Tasks snapshot={snapshot} go={setRoute} />}
        {route.page === 'task' && <TaskDetail taskKey={route.key} tab={route.tab} version={version} go={setRoute} all={snapshot.tasks} />}
        {route.page === 'settings' && <Settings snapshot={snapshot} />}
      </main>
    </div>
  )
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}
