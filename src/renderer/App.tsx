import { CircleAlert, Inbox, KeyRound, LayoutList, PauseCircle, Settings as SettingsIcon, Waypoints } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Route, Snapshot } from '../shared/api.js'
import { api, onChanged, onNavigate, setIntake } from './api.js'
import { Button, RefreshContext, Toggle, ToastProvider, useRun } from './components/ui.js'
import { NeedsYou } from './pages/NeedsYou.js'
import { Settings } from './pages/Settings.js'
import { ownerOf, TaskDetail } from './pages/TaskDetail.js'
import { Tasks } from './pages/Tasks.js'
import { timeAgo } from './model.js'
import { executorLabel } from '../shared/labels.js'
import { occupiesTaskCapacity } from '../shared/task-status.js'
import { ExecutorsContext } from './components/Review.js'
import { ProjectsContext } from './projects.js'

// Problems and pauses, per project. With several projects each line names its project.
function Banners({ snapshot, go }: { snapshot: Snapshot; go: (r: Route) => void }) {
  const run = useRun()
  const banners = []
  if (!snapshot.configured) {
    banners.push(
      <div key="setup" className="banner banner-warn">
        <CircleAlert size={16} /><span className="grow">还没有配置项目。</span>
        <Button small kind="primary" onClick={() => go({ page: 'settings' })}>去设置</Button>
      </div>,
    )
  }
  const many = snapshot.projects.length > 1
  for (const project of snapshot.projects) {
    const { engine, auth } = project
    const who = many ? `${project.name}：` : ''
    if (auth.mode === 'oauth' && (!auth.loggedIn || engine.authRequired)) {
      banners.push(
        <div key={project.id + '-auth'} className="banner banner-warn">
          <KeyRound size={16} />
          <span className="grow">{who}{auth.loggedIn ? 'AI PM 平台的登录已失效。' : '还没有登录 AI PM 平台。'}正在运行的 Agent 不受影响，读写平台已暂停。</span>
          <Button small kind="primary" onClick={() => run(api.login(project.id), '登录成功')}>登录</Button>
        </div>,
      )
    }
    if (engine.bindingError) {
      banners.push(
        <div key={project.id + '-binding'} className="banner banner-danger">
          <CircleAlert size={16} /><span className="grow">{who}项目绑定核对失败：{engine.bindingError}。已停止接新需求，请检查设置。</span>
        </div>,
      )
    }
    if (engine.contractError) {
      banners.push(
        <div key={project.id + '-contract'} className="banner banner-danger">
          <CircleAlert size={16} /><span className="grow">{who}{engine.contractError}。已停止接新需求，已认领的任务会继续推进。</span>
        </div>,
      )
    }
    if (engine.intakePaused) {
      banners.push(
        <div key={project.id + '-paused'} className="banner banner-info">
          <PauseCircle size={16} /><span className="grow">{who}已暂停接新需求，已认领的任务会继续推进。</span>
          <Button small onClick={() => run(setIntake(project.id, false), '已恢复接单')}>恢复接单</Button>
        </div>,
      )
    }
  }
  return banners.length ? <div className="banners">{banners}</div> : null
}

function Shell() {
  const [route, setRoute] = useState<Route>({ page: 'needs' })
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => api.snapshot().then((s) => {
    setSnapshot(s)
    setVersion((v) => v + 1)
  }), [])
  const run = useRun(refresh)
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
  const active = snapshot.tasks.filter(occupiesTaskCapacity).length
  const running = snapshot.tasks.filter((t) => t.status === 'running').length
  const nav = [
    { route: { page: 'needs' } as Route, label: '待你处理', icon: <Inbox size={16} />, count: needs, hot: true },
    { route: { page: 'tasks' } as Route, label: '全部任务', icon: <LayoutList size={16} />, count: active, hot: false },
    { route: { page: 'settings' } as Route, label: '设置', icon: <SettingsIcon size={16} />, count: 0, hot: false },
  ]
  const current = route.page === 'task' ? 'tasks' : route.page
  return (
    <RefreshContext.Provider value={refresh}>
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
            {snapshot.projects.map((project) => {
              const { engine } = project
              const dot = 'dot ' + (engine.connected ? 'dot-ok' : engine.running ? 'dot-warn' : '')
              const state = engine.connected ? '已连接平台' : engine.running ? '正在连接…' : '未运行'
              // Several projects: one line each, with its own intake switch.
              if (snapshot.projects.length > 1) {
                return (
                  <div key={project.id} className="status-line" title={state + (engine.lastReconcileAt ? ' · ' + timeAgo(engine.lastReconcileAt) : '')}>
                    <span className={dot} />
                    <span className="grow ellipsis">{project.name}</span>
                    <Toggle on={!engine.intakePaused} label={project.name + ' 接新需求'}
                      onChange={(on) => run(setIntake(project.id, !on), on ? '已恢复接单' : '已暂停接新需求')} />
                  </div>
                )
              }
              return (
                <div key={project.id} className="status-line">
                  <span className={dot} />
                  {state}
                  {engine.lastReconcileAt && <span className="hint">{timeAgo(engine.lastReconcileAt)}</span>}
                </div>
              )
            })}
            {snapshot.executors.filter((e) => e.configured).map((e) => {
              const busy = snapshot.tasks.filter((t) => t.running && (t.stage === 'review' && t.reviewer ? t.reviewer : t.executor) === e.name).length
              return (
                <div key={e.name} className="status-line">
                  <span className={'dot ' + (e.healthy === false ? 'dot-bad' : busy ? 'dot-live' : e.healthy ? 'dot-ok' : '')} />
                  {executorLabel(e.name)}
                  <span className="hint">{e.healthy === false ? '不可用' : busy ? `${busy} 个运行中` : '空闲'}</span>
                </div>
              )
            })}
            {snapshot.projects.length === 1 && (
              <div className="status-line">
                <span>接新需求</span>
                <span className="hint"><Toggle on={!snapshot.projects[0].engine.intakePaused} label="接新需求"
                  onChange={(on) => run(setIntake(snapshot.projects[0].id, !on), on ? '已恢复接单' : '已暂停接新需求')} /></span>
              </div>
            )}
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="drag-strip" />
        <Banners snapshot={snapshot} go={setRoute} />
        <ProjectsContext.Provider value={snapshot.projects}>
        <ExecutorsContext.Provider value={snapshot.executors}>
          {route.page === 'needs' && <NeedsYou snapshot={snapshot} go={setRoute} />}
          {route.page === 'tasks' && <Tasks snapshot={snapshot} go={setRoute} />}
          {route.page === 'task' && <TaskDetail taskKey={ownerOf(route.key, snapshot.tasks)} tab={route.tab} version={version} go={setRoute} all={snapshot.tasks} />}
          {route.page === 'settings' && <Settings snapshot={snapshot} />}
        </ExecutorsContext.Provider>
        </ProjectsContext.Provider>
      </main>
    </div>
    </RefreshContext.Provider>
  )
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}
