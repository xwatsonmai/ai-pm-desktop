import { CircleAlert, Inbox, KeyRound, LayoutList, PauseCircle, SlidersHorizontal, FolderPlus, Settings as SettingsIcon, Waypoints } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Route, Snapshot } from '../shared/api.js'
import { api, onChanged, onNavigate, setIntake } from './api.js'
import { Button, RefreshContext, Toggle, ToastProvider, useRun, useToast } from './components/ui.js'
import { NeedsYou } from './pages/NeedsYou.js'
import { ClientSettings, Settings } from './pages/Settings.js'
import { ownerOf, TaskDetail } from './pages/TaskDetail.js'
import { Tasks } from './pages/Tasks.js'
import { timeAgo } from './model.js'
import { executorLabel } from '../shared/labels.js'
import { occupiesTaskCapacity } from '../shared/task-status.js'
import { ExecutorsContext } from './components/Review.js'
import { ProjectsContext, WorkspaceIdContext } from './projects.js'

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

export function ProjectSwitcher({ snapshot, selected, onSelect, onAdd }: {
  snapshot: Snapshot; selected: string | null; onSelect: (id: string) => void; onAdd: () => void
}) {
  return <div className="workspace-switcher">
    <span className="workspace-caption">项目工作区</span>
    {snapshot.projects.length ? <select aria-label="切换项目工作区" value={selected ?? ''} onChange={(e) => e.target.value === '__add__' ? onAdd() : onSelect(e.target.value)}>
      {snapshot.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.counts.needs ? ` · ${p.counts.needs} 待处理` : ''}</option>)}
      <option value="__add__">＋ 添加项目</option>
    </select> : <Button icon={<FolderPlus size={14} />} onClick={onAdd}>添加项目</Button>}
  </div>
}

export function UnsavedChangesDialog({ onStay, onDiscard }: { onStay: () => void; onDiscard: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => previous?.focus()
  }, [])
  return <div className="dialog-backdrop"><div ref={panel} className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="unsaved-title" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); onStay() }
    if (event.key === 'Tab') {
      const buttons = panel.current?.querySelectorAll('button')
      if (!buttons?.length) return
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }}>
    <h2 id="unsaved-title">有未保存的设置</h2><p className="hint">离开会放弃当前页面的修改，已保存的配置和正在运行的任务不受影响。</p>
    <div className="row"><Button kind="primary" onClick={onStay}>留在此页</Button><Button onClick={onDiscard}>放弃修改并离开</Button></div>
  </div></div>
}

function Shell() {
  const [route, setRoute] = useState<Route>({ page: 'needs' })
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [version, setVersion] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [pendingRoute, setPendingRoute] = useState<Route | null>(null)
  const projectRef = useRef<string | null>(null)
  const request = useRef(0)
  const mainRef = useRef<HTMLElement>(null)
  const toast = useToast()
  const refresh = useCallback(async () => {
    const generation = ++request.current
    let next: Snapshot
    try { next = await api.snapshot(projectRef.current) }
    catch { next = await api.snapshot() } // the selected project may have been removed
    if (generation !== request.current) return
    projectRef.current = next.projectId
    setSnapshot(next)
    setVersion((v) => v + 1)
  }, [])
  const run = useRun(refresh)
  const navigate = useCallback(async (next: Route, saved = false) => {
    const target = 'project' in next ? next.project : undefined
    const samePage = next.page === route.page && (next.page !== 'task' || (route.page === 'task' && next.key === route.key && next.tab === route.tab))
    if (!saved && samePage && (!target || target === projectRef.current)) return
    if (!saved && dirty) { setPendingRoute(next); return }
    if (target && target !== projectRef.current) {
      const selected = await api.selectProject(target)
      if (!selected.ok) { toast(selected.message, 'danger'); return }
      projectRef.current = target
      // Never render the previous project's rows or actions under the new name.
      setSnapshot((current) => current ? { ...current, projectId: target, tasks: [], executors: [] } : current)
    }
    setDirty(false)
    setRoute(next)
    mainRef.current?.scrollTo({ top: 0 })
    await refresh()
  }, [dirty, refresh, toast, route])
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(() => {
    void refresh()
    const offChanged = onChanged(() => { void refresh() })
    const offNavigate = onNavigate((next) => { void navigateRef.current(next) })
    const timer = setInterval(() => { void refresh() }, 5_000)
    return () => { offChanged(); offNavigate(); clearInterval(timer) }
  }, [refresh])
  useEffect(() => {
    if (snapshot && !snapshot.configured && route.page !== 'client') setRoute({ page: 'add-project' })
  }, [snapshot?.configured])
  if (!snapshot) return <div className="loading">正在启动…</div>
  const project = snapshot.projects.find((p) => p.id === snapshot.projectId)
  const scoped = { ...snapshot, projects: project ? [project] : [] }
  const go = (next: Route) => { void navigate(next) }
  const current = route.page === 'task' ? 'tasks' : route.page
  const nav = [
    { page: 'needs' as const, label: '待你处理', icon: <Inbox size={16} />, count: project?.counts.needs ?? 0, hot: true },
    { page: 'tasks' as const, label: '全部任务', icon: <LayoutList size={16} />, count: project?.counts.active ?? 0, hot: false },
    { page: 'settings' as const, label: '项目设置', icon: <SettingsIcon size={16} />, count: 0, hot: false },
  ]
  return <RefreshContext.Provider value={refresh}>
    <div className="shell" inert={pendingRoute ? true : undefined}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Waypoints size={15} /></span><span className="brand-name">AI PM</span></div>
        <ProjectSwitcher snapshot={snapshot} selected={snapshot.projectId} onSelect={(id) => go({ page: 'needs', project: id })} onAdd={() => go({ page: 'add-project' })} />
        <nav className="nav" aria-label="项目导航">
          {nav.map((item) => <button key={item.page} disabled={!project} className={'nav-item' + (current === item.page ? ' active' : '')} onClick={() => go({ page: item.page })}>
            {item.icon}<span className="nav-label">{item.label}</span>{item.count > 0 && <span className={'nav-count' + (item.hot ? ' hot' : '')}>{item.count}</span>}
          </button>)}
        </nav>
        <div className="sidebar-foot">
          {project && <div className="status-card">
            <div className="status-line"><span className={'dot ' + (project.engine.connected ? 'dot-ok' : 'dot-warn')} /><span className="grow">{project.engine.connected ? '平台已连接' : project.engine.running ? '正在连接平台…' : '平台未运行'}</span></div>
            <div className="status-line"><span className="grow">本项目接新需求</span><Toggle on={!project.engine.intakePaused} label={project.name + ' 接新需求'} onChange={(on) => run(setIntake(project.id, !on), on ? '已恢复本项目接单' : '已暂停本项目接单')} /></div>
            {snapshot.executors.filter((e) => e.enabled || snapshot.tasks.some((t) => t.running && (t.stage === 'review' ? t.reviewer : t.executor) === e.name)).map((e) => {
              const own = snapshot.tasks.filter((t) => t.running && (t.stage === 'review' && t.reviewer ? t.reviewer : t.executor) === e.name).length
              return <div key={e.name} className="status-line" title={`本项目 ${own} 个运行中；本机所有项目合计占用 ${e.busy}/${e.limit} 个名额`}>
                <span className={'dot ' + (!e.configured || e.healthy === false ? 'dot-bad' : own ? 'dot-live' : 'dot-ok')} />{executorLabel(e.name)}
                <span className="hint">{!e.configured ? '未配置' : e.healthy === false ? '不可用' : own ? `${own} 个运行中` : '空闲'}</span>
              </div>
            })}
            {!project.allowedExecutors.length && <button className="link hint" onClick={() => go({ page: 'settings' })}>尚未启用执行器 →</button>}
          </div>}
          <button className={'nav-item client-settings-link' + (current === 'client' ? ' active' : '')} onClick={() => go({ page: 'client' })}>
            <SlidersHorizontal size={16} /><span className="nav-label">客户端配置</span><span className="scope-label">本机</span>
          </button>
        </div>
      </aside>
      <main className="main" ref={mainRef}>
        <div className="drag-strip" />
        {route.page !== 'client' && route.page !== 'add-project' && <Banners snapshot={scoped} go={go} />}
        <WorkspaceIdContext.Provider value={snapshot.projectId}>
        <ProjectsContext.Provider value={scoped.projects}>
        <ExecutorsContext.Provider value={snapshot.executors}>
          <div key={`${snapshot.projectId}:${route.page}`}>
            {route.page === 'needs' && <NeedsYou snapshot={scoped} go={go} />}
            {route.page === 'tasks' && <Tasks snapshot={scoped} go={go} />}
            {route.page === 'task' && <TaskDetail key={route.key} taskKey={ownerOf(route.key, snapshot.tasks)} tab={route.tab} version={version} go={go} all={snapshot.tasks} />}
            {(route.page === 'settings' || route.page === 'add-project') && <Settings snapshot={snapshot} projectId={route.page === 'add-project' ? null : snapshot.projectId} go={go} onDirty={setDirty}
              onSaved={async (id) => { await navigate(id ? { page: 'settings', project: id } : { page: 'needs' }, true) }} />}
            {route.page === 'client' && <ClientSettings onDirty={setDirty} />}
          </div>
        </ExecutorsContext.Provider>
        </ProjectsContext.Provider>
        </WorkspaceIdContext.Provider>
      </main>
    </div>
    {pendingRoute && <UnsavedChangesDialog onStay={() => setPendingRoute(null)} onDiscard={() => { const next = pendingRoute; setPendingRoute(null); void navigate(next, true) }} />}
  </RefreshContext.Provider>
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}
