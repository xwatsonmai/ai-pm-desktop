import { useEffect, useState, type ReactNode } from 'react'
import type { ExecutorName, ExecutorSettings } from '../../core/types.js'
import type { AppSettings, GlobalSettings, ProbeStep, ProjectSettings, ProjectBinding, Snapshot, Route } from '../../shared/api.js'
import { api } from '../api.js'
import { CircleCheck, CircleX, Download, KeyRound, PlugZap, Plus, Save, ScanSearch, Trash2 } from 'lucide-react'
import { Badge, Button, PageHeader, Section, useRun, useToast } from '../components/ui.js'
import { executorLabel } from '../../shared/labels.js'
import { ModelPicker, type Catalog } from '../components/ModelPicker.js'
import { ProjectConnection } from '../components/ProjectBinding.js'
import { readCatalog } from '../model-catalog.js'

const EMPTY_PROJECT: ProjectSettings = {
  projectId: '', mcpUrl: '', resourceUri: '', repository: '', repoPath: '', startRef: 'origin/main',
  testReleaseInstructions: '', releaseInstructions: '', maxOpenTasks: 5, intakePaused: true, allowedExecutors: [],
}
const EMPTY_GLOBALS: GlobalSettings = { executors: {} }
const NEW = 'new'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

// New requirements go to the first enabled executor, in this order, that has a free slot.
const EXECUTORS: ExecutorName[] = ['codex', 'claude', 'zcode']

const ABOUT: Record<ExecutorName, string> = {
  codex: 'OpenAI Codex CLI，用你本机 Codex 的登录。',
  claude: 'Claude Code，用你本机 Claude Code 的登录。',
  zcode: 'ZCode，用 ZCode 里登录的账号和配置好的模型服务商，通过 ZCode 自带的 CLI 运行。',
}

// Read the model list from the CLI the form points at, once the path stops changing.
function useCatalog(name: ExecutorName, binary: string, runtime: string | undefined) {
  const [generation, setGeneration] = useState(0)
  const [catalog, setCatalog] = useState<Catalog>({ models: null, error: null })
  useEffect(() => {
    setCatalog({ models: null, error: null })
    if (!binary) { setCatalog({ models: null, error: '请先填写或自动探测程序路径' }); return }
    let live = true
    const timer = setTimeout(() => {
      void readCatalog(() => api.listModels(name, { binary, runtime }, generation > 0)).then((result) => { if (live) setCatalog(result) })
    }, 500)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [name, binary, runtime, generation])
  return { catalog, refresh: () => setGeneration((n) => n + 1) }
}

function ExecutorSection({ name, config, onChange }: {
  name: ExecutorName; config: ExecutorSettings | undefined
  onChange: (value: ExecutorSettings) => void
}) {
  const toast = useToast()
  const label = executorLabel(name)
  const current = config ?? { binary: '', limit: 1 }
  const { catalog, refresh } = useCatalog(name, config?.binary ?? '', config?.runtime)
  const update = (patch: Partial<ExecutorSettings>) => onChange({ ...current, ...patch })
  const detect = async () => {
    const found = await api.detectExecutor(name)
    if (found) update(found)
    else toast(`没有找到 ${label}，请手动填写路径`, 'danger')
  }
  const model = (role: 'expert' | 'execution') => current.models?.[role] ?? {}
  const setModel = (role: 'expert' | 'execution', next: { model?: string; effort?: string }) =>
    update({ models: { ...current.models, [role]: { model: next.model || undefined, effort: next.effort || undefined } } })
  return (
    <Section title={'执行器 · ' + label} description={ABOUT[name]} aside={config?.binary ? <Badge tone="ok">已配置</Badge> : undefined}>
      {!config ? <div className="row"><p className="hint grow">尚未配置。在这里配置后，各项目可单独选择是否使用。</p><Button small icon={<ScanSearch size={13} />} onClick={async () => { onChange(current); await detect() }}>配置 {label}</Button></div> : (
        <div className="grid">
          <Field label={name === 'zcode' ? 'CLI 脚本路径' : '程序路径'}>
            <div className="row">
              <input value={current.binary} onChange={(e) => update({ binary: e.target.value })} />
              <Button small icon={<ScanSearch size={13} />} onClick={detect}>自动探测</Button>
            </div>
          </Field>
          {name === 'zcode' && (
            <Field label="运行环境" hint="运行 CLI 脚本的程序，默认用 ZCode 应用自带的">
              <input value={current.runtime ?? ''} onChange={(e) => update({ runtime: e.target.value || undefined })} />
            </Field>
          )}
          <Field label="同时运行的名额" hint="本机所有项目合计 1 到 8；调低不会打断正在运行的任务">
            <input type="number" min={1} max={8} value={current.limit} onChange={(e) => update({ limit: Number(e.target.value) })} />
          </Field>
          <div className="row" style={{ gridColumn: '1 / -1' }}><Button small disabled={!current.binary} onClick={refresh}>重新获取模型</Button><span className="hint">登录、切换账号或配置模型服务后可重新获取；不会修改已选择的模型。</span></div>
          {(['expert', 'execution'] as const).map((role) => (
            <Field key={role} label={role === 'expert' ? '专家模型（方案、协同）' : '执行模型（开发、修复、发布）'}
              hint={catalog.error ? catalog.error + '，可以手动填写模型 ID' : catalog.models ? `列表来自你本机的 ${label}，强度只列出这个模型支持的` : `正在从 ${label} 读取可用模型…`}>
              <ModelPicker owner={label} catalog={catalog} value={model(role)} onChange={(next) => setModel(role, next)} />
            </Field>
          ))}
          {name !== 'zcode' && (
            <label className="check">
              <input type="checkbox" checked={current.isolateUserConfig !== false} onChange={(e) => update({ isolateUserConfig: e.target.checked })} />
              不加载 {label} 用户配置（推荐）：Agent 会话不会接触你配置里的 MCP 服务，包括 AI PM 平台
            </label>
          )}
          {name === 'codex' ? (
            <Field label="Codex 配置覆盖" hint="每行一条 key=value（TOML 写法），作为 -c 传给 Codex。例如给 Agent 加一个运营查询的 MCP 服务">
              <textarea rows={3} spellCheck={false} value={(current.configOverrides ?? []).join('\n')}
                onChange={(e) => update({ configOverrides: e.target.value.split('\n') })} />
            </Field>
          ) : (
            <Field label="给 Agent 的 MCP 服务" hint={'JSON，格式 {"mcpServers": {"名字": {"type": "http", "url": "…", "headers": {…}}}}。例如运营查询服务；不要填 AI PM 平台'}>
              <textarea rows={3} spellCheck={false} value={current.mcpConfig ?? ''} onChange={(e) => update({ mcpConfig: e.target.value || undefined })} />
            </Field>
          )}
        </div>
      )}
    </Section>
  )
}

// A project's own settings: its platform login, binding, release notes and intake.
function ProjectForm({ id, form, set, snapshot, onRemoved, binding, onBinding, defaultEntry }: {
  id: string; form: ProjectSettings; set: (patch: Partial<ProjectSettings>) => void; snapshot: Snapshot; onRemoved: () => void
  binding: ProjectBinding | null; onBinding: (value: ProjectBinding) => void; defaultEntry?: string
}) {
  const run = useRun()
  const [probe, setProbe] = useState<ProbeStep[] | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [removing, setRemoving] = useState(false)
  useEffect(() => setProbe(null), [id])
  const saved = snapshot.projects.find((p) => p.id === id)
  return (
    <>
      {saved && <Section title="登录与连接" description="客户端用你自己的账号登录 AI PM 平台，每个项目单独授权。Agent 不会拿到这份授权。">
        {saved.auth.mode === 'static' ? (
          <p className="hint">正在使用静态令牌（开发和测试用）。</p>
        ) : (
          <div className="row">
            {saved.auth.loggedIn && !saved.engine.authRequired
              ? <Badge tone="ok">已登录</Badge>
              : <Badge tone="warn">{saved.auth.loggedIn ? '登录已失效' : '未登录'}</Badge>}
            <Button icon={<KeyRound size={14} />} kind={saved.auth.loggedIn && !saved.engine.authRequired ? 'secondary' : 'primary'} disabled={loggingIn}
              onClick={async () => {
                setLoggingIn(true)
                try {
                  await run(api.login(id), '登录成功')
                } finally {
                  setLoggingIn(false)
                }
              }}>
              {loggingIn ? '请在浏览器里完成授权…' : saved.auth.loggedIn ? '重新登录' : '登录 AI PM 平台'}
            </Button>
            <span className="hint">授权页上选这个项目</span>
          </div>
        )}
        {saved?.auth.lastError && !loggingIn && <p className="hint danger-text">上次登录没有成功：{saved.auth.lastError}</p>}
        {saved && (
          <div className="row">
            <Button icon={<PlugZap size={14} />} onClick={async () => setProbe(await api.probe(id))}>测试连接（只读）</Button>
            <span className="hint">只读取项目信息、任务列表和订阅，不做任何写操作。</span>
          </div>
        )}
        {probe && (
          <ul className="probe">
            {probe.map((s) => (
              <li key={s.step}>
                {s.ok ? <CircleCheck size={16} className="ok" /> : <CircleX size={16} className="bad" />}
                <strong>{s.step}</strong>
                <span className="muted">{s.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>}

      <ProjectConnection key={id} id={saved ? id : undefined} form={form} set={set} binding={binding} onBinding={onBinding} defaultEntry={defaultEntry} />

      {(saved || binding) && <><Section title="发布说明" description="点“提测”或“上线”后，发布 Agent 按这里的说明决定是否合并、合到哪里、如何部署和验证。">
        <Field label="测试发布说明">
          <textarea rows={4} value={form.testReleaseInstructions} onChange={(e) => set({ testReleaseInstructions: e.target.value })} />
        </Field>
        <Field label="上线发布说明">
          <textarea rows={4} value={form.releaseInstructions} onChange={(e) => set({ releaseInstructions: e.target.value })} />
        </Field>
        <Field label="环境说明" hint="Agent 访问测试、生产环境或运营数据时按这里的方式，会写进工作区的 .ai-pm/environment.md">
          <textarea rows={4} value={form.environmentInstructions ?? ''} onChange={(e) => set({ environmentInstructions: e.target.value })} />
        </Field>
      </Section>

      <Section title="接单" description="暂停接单不影响已经认领的需求。">
        <label className="check">
          <input type="checkbox" checked={!!form.intakePaused} onChange={(e) => set({ intakePaused: e.target.checked })} />
          暂停这个项目接新需求（已认领的任务继续推进）
        </label>
        <Field label="同时处理的需求上限" hint="这个项目里，包括等你处理和等平台的需求；待验收不占名额">
          <input type="number" min={1} value={form.maxOpenTasks} onChange={(e) => set({ maxOpenTasks: Number(e.target.value) })} />
        </Field>
        {saved && (
          <div className="row">
            {removing ? (
              <>
                <Button kind="danger" icon={<Trash2 size={14} />} onClick={async () => {
                  if (await run(api.removeProject(id), '已移除项目')) onRemoved()
                }}>确认移除</Button>
                <Button kind="ghost" onClick={() => setRemoving(false)}>取消</Button>
                <span className="hint">不再接这个项目的需求；本地数据和工作区保留在磁盘上。</span>
              </>
            ) : (
              <Button kind="ghost" icon={<Trash2 size={14} />} onClick={() => setRemoving(true)}>移除这个项目</Button>
            )}
          </div>
        )}
      </Section></>}
    </>
  )
}


function useDirty(value: unknown, baseline: unknown, onDirty?: (dirty: boolean) => void) {
  const dirty = baseline !== null && JSON.stringify(value) !== JSON.stringify(baseline)
  useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])
  useEffect(() => () => onDirty?.(false), [onDirty])
  return dirty
}

export function ProjectExecutors({ form, set, globals, go }: {
  form: ProjectSettings; set: (patch: Partial<ProjectSettings>) => void; globals: GlobalSettings; go: (route: Route) => void
}) {
  return <Section title="本项目执行器" description="只影响当前项目。新任务、评审和重试使用这里启用的执行器；模型与本机总并发在客户端配置中维护。"
    aside={<Button small kind="ghost" onClick={() => go({ page: 'client' })}>客户端配置 →</Button>}>
    <div className="project-executors">
      {EXECUTORS.map((name) => {
        const config = globals.executors[name]
        const configured = !!config?.binary?.trim()
        return <label className={'executor-choice' + (!configured ? ' unconfigured' : '')} key={name}>
          <input type="checkbox" disabled={!configured} checked={form.allowedExecutors.includes(name)} onChange={(e) => {
            const chosen = new Set(form.allowedExecutors)
            if (e.target.checked) chosen.add(name); else chosen.delete(name)
            set({ allowedExecutors: EXECUTORS.filter((n) => chosen.has(n)) })
          }} />
          <span><strong>{executorLabel(name)}</strong><span className="hint">{configured ? `专家：${config?.models?.expert?.model || '默认模型'} · 执行：${config?.models?.execution?.model || '默认模型'}` : '尚未配置，请先到客户端配置添加'}</span></span>
        </label>
      })}
    </div>
    {!form.allowedExecutors.length && <p className="hint">尚未启用执行器，本项目不会领取新任务。可先保存项目，稍后再启用。</p>}
    <p className="hint">停用不会中断正在运行的轮次。尚未启动的轮次会提示你选择其他执行器，保留原工作区和记录。</p>
  </Section>
}

export function Settings({ snapshot, projectId, go, onSaved, onDirty }: {
  snapshot: Snapshot; projectId: string | null; go: (route: Route) => void
  onSaved: (id: string) => Promise<void>; onDirty?: (dirty: boolean) => void
}) {
  const [binding, setBinding] = useState<ProjectBinding | null>(null)
  useEffect(() => () => { if (binding?.ticket) void api.cancelProjectBinding(binding.ticket) }, [binding?.ticket])
  const [app, setApp] = useState<AppSettings | null>(null)
  const [form, setForm] = useState<ProjectSettings>(EMPTY_PROJECT)
  const [baseline, setBaseline] = useState<ProjectSettings | null>(null)
  const run = useRun()
  const toast = useToast()
  const load = async (id: string | null = projectId) => {
    const settings = await api.getSettings()
    setApp(settings)
    const value = settings.projects.find((p) => p.id === id)?.settings ?? EMPTY_PROJECT
    setForm(value); setBaseline(value)
  }
  useEffect(() => { void load() }, [projectId])
  const dirty = useDirty(form, baseline, onDirty)
  if (!app) return <p className="hint page">读取中…</p>
  const saved = snapshot.projects.find((p) => p.id === projectId)
  const setProject = (patch: Partial<ProjectSettings>) => setForm((current) => ({ ...current, ...patch }))
  const save = async () => {
    if (!projectId && !binding?.ticket) return toast('请先登录平台并选择授权项目', 'danger')
    const result = await api.saveProject(projectId, form, binding?.ticket)
    if (!result.ok) return toast(result.message, 'danger')
    setBinding(null)
    await load(result.value)
    toast(projectId ? '项目设置已保存' : '项目绑定完成')
    await onSaved(result.value)
  }
  return <div className="page settings">
    <PageHeader title={projectId ? '项目设置' : '添加项目'} subtitle={projectId ? `${saved?.name ?? '当前项目'} · 仅对这个项目生效，保存在本机。` : '连接平台并选择项目，再绑定本地仓库。已有项目继续在后台运行。'} />
    {!projectId && <div className="row settings-import"><Button small icon={<Download size={13} />} onClick={async () => {
      const legacy = await api.importLegacy()
      if (!legacy) return toast('没有找到旧客户端的配置', 'danger')
      setForm({ ...legacy.project, allowedExecutors: legacy.project.allowedExecutors.filter((n) => !!app.globals.executors[n]?.binary) })
      toast('已读取项目配置。执行器配置可在客户端配置中单独导入。')
    }}>从旧客户端导入项目</Button></div>}
    {(projectId || binding) && <ProjectExecutors form={form} set={setProject} globals={app.globals} go={go} />}
    <ProjectForm key={projectId ?? NEW} id={projectId ?? NEW} form={form} set={setProject} snapshot={snapshot} binding={binding} onBinding={setBinding}
      defaultEntry={app.projects[0]?.settings.mcpUrl} onRemoved={() => { onDirty?.(false); void onSaved('') }} />
    <div className="save-bar">
      <Button kind="primary" icon={<Save size={14} />} onClick={save}>{projectId ? '保存项目设置' : '完成绑定并保存'}</Button>
      {dirty && <Badge tone="warn">未保存</Badge>}<span className="hint">仅保存当前项目。客户端执行器配置在单独入口维护。</span>
    </div>
  </div>
}

export function ClientSettings({ onDirty }: { onDirty?: (dirty: boolean) => void }) {
  const [globals, setGlobals] = useState<GlobalSettings | null>(null)
  const [baseline, setBaseline] = useState<GlobalSettings | null>(null)
  const [atLogin, setAtLogin] = useState<boolean | null>(null)
  const run = useRun()
  const toast = useToast()
  useEffect(() => {
    let live = true
    void api.getSettings().then((settings) => { if (live) { setGlobals(settings.globals); setBaseline(settings.globals) } })
    void api.launchAtLogin().then((on) => { if (live) setAtLogin(on) })
    return () => { live = false }
  }, [])
  const dirty = useDirty(globals, baseline, onDirty)
  if (!globals) return <p className="hint page">读取中…</p>
  return <div className="page settings">
    <PageHeader title="客户端配置" subtitle="本机所有项目共用。配置执行器的程序、模型和总并发；是否使用由每个项目单独决定。" />
    <div className="row settings-import"><Button small icon={<Download size={13} />} onClick={async () => {
      const legacy = await api.importLegacy()
      if (!legacy) return toast('没有找到旧客户端的配置', 'danger')
      setGlobals(legacy.globals)
      toast('已读取执行器配置，检查后保存。项目的启用选择不会改变。')
    }}>从旧客户端导入执行器</Button></div>
    {EXECUTORS.map((name) => <ExecutorSection key={name} name={name} config={globals.executors[name]}
      onChange={(value) => setGlobals((current) => ({ ...current!, executors: { ...current!.executors, [name]: value } }))} />)}
    <Section title="工作区清理" description="任务完成或关闭后，超过保留天数才清理工作区；有未提交改动的不删。">
      <Field label="完成后保留工作区的天数"><input type="number" min={1} value={globals.worktreeRetentionDays ?? 14} onChange={(e) => setGlobals({ ...globals, worktreeRetentionDays: Number(e.target.value) })} /></Field>
    </Section>
    <Section title="启动" description="关掉窗口后客户端继续在托盘或菜单栏运行。">
      <label className="check"><input type="checkbox" disabled={atLogin === null} checked={!!atLogin} onChange={async (e) => {
        if (await run(api.setLaunchAtLogin(e.target.checked).then(() => ({ ok: true as const, value: undefined })))) setAtLogin(await api.launchAtLogin())
      }} />登录电脑时自动启动（后台运行，不打开窗口）</label>
    </Section>
    <div className="save-bar"><Button kind="primary" icon={<Save size={14} />} onClick={async () => {
      if (await run(api.saveGlobals(globals), '客户端配置已保存')) setBaseline(globals)
    }}>保存客户端配置</Button>{dirty && <Badge tone="warn">未保存</Badge>}<span className="hint">影响所有项目后续运行；正在运行的 Agent 不会中断。</span></div>
  </div>
}
