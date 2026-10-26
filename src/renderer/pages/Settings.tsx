import { useEffect, useState, type ReactNode } from 'react'
import type { ExecutorName, ExecutorSettings } from '../../core/types.js'
import type { ProbeStep, Settings as SettingsData, Snapshot } from '../../shared/api.js'
import { api } from '../api.js'
import { CircleCheck, CircleX, Download, KeyRound, PlugZap, Save, ScanSearch } from 'lucide-react'
import { Badge, Button, PageHeader, Section, useRun, useToast } from '../components/ui.js'
import { executorLabel } from '../../shared/labels.js'
import { ModelPicker, type Catalog } from '../components/ModelPicker.js'

const EMPTY: SettingsData = {
  projectId: '', mcpUrl: '', resourceUri: '', repository: '', repoPath: '', startRef: 'origin/main',
  executors: { codex: { binary: '', limit: 1 } }, allowedExecutors: ['codex'], testReleaseInstructions: '',
  releaseInstructions: '', maxOpenTasks: 5, intakePaused: true,
}

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
  claude: 'Claude Code，用你本机 Claude Code 的登录。只读阶段只放行读取类工具和只读命令。',
  zcode: 'ZCode，用 ZCode 里登录的账号和配置好的模型服务商，通过 ZCode 自带的 CLI 运行。',
}

// Read the model list from the CLI the form points at, once the path stops changing.
function useCatalog(name: ExecutorName, binary: string, runtime: string | undefined): Catalog {
  const [catalog, setCatalog] = useState<Catalog>({ models: null, error: null })
  useEffect(() => {
    setCatalog({ models: null, error: null })
    if (!binary) return
    let live = true
    const timer = setTimeout(() => {
      api.listModels(name, { binary, runtime }).then((r) => live && setCatalog(r.ok ? { models: r.value, error: null } : { models: null, error: r.message }))
    }, 500)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [name, binary, runtime])
  return catalog
}

function ExecutorSection({ name, config, allowed, onChange, onAllowed }: {
  name: ExecutorName; config: ExecutorSettings | undefined; allowed: boolean
  onChange: (value: ExecutorSettings) => void; onAllowed: (on: boolean) => void
}) {
  const toast = useToast()
  const label = executorLabel(name)
  const current = config ?? { binary: '', limit: 1 }
  const catalog = useCatalog(name, config?.binary ?? '', config?.runtime)
  const update = (patch: Partial<ExecutorSettings>) => onChange({ ...current, ...patch })
  const detect = async () => {
    const found = await api.detectExecutor(name)
    if (found) update(found)
    else toast(`没有找到 ${label}，请手动填写路径`, 'danger')
  }
  const model = (role: 'expert' | 'execution') => current.models?.[role] ?? {}
  const setModel = (role: 'expert' | 'execution', next: { model?: string; effort?: string }) =>
    update({ models: { ...current.models, [role]: { model: next.model || undefined, effort: next.effort || undefined } } })
  const enable = (
    <label className="check inline">
      <input type="checkbox" checked={allowed} onChange={async (e) => {
        onAllowed(e.target.checked)
        if (e.target.checked && !config?.binary) await detect()
      }} />
      接新需求
    </label>
  )
  return (
    <Section title={'执行器 · ' + label} description={ABOUT[name]} aside={enable}>
      {!config && !allowed ? <p className="hint">没有启用。勾选“接新需求”后会自动查找本机的 {label}。</p> : (
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
          <Field label="同时运行的名额" hint="1 到 8；调低不会打断正在运行的任务">
            <input type="number" min={1} max={8} value={current.limit} onChange={(e) => update({ limit: Number(e.target.value) })} />
          </Field>
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

export function Settings({ snapshot }: { snapshot: Snapshot }) {
  const [form, setForm] = useState<SettingsData | null>(null)
  const [probe, setProbe] = useState<ProbeStep[] | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [atLogin, setAtLogin] = useState<boolean | null>(null)
  const run = useRun()
  const toast = useToast()
  useEffect(() => {
    api.getSettings().then((s) => setForm(s ?? EMPTY))
    api.launchAtLogin().then(setAtLogin)
  }, [])
  if (!form) return <p className="hint page">读取中…</p>
  const set = (patch: Partial<SettingsData>) => setForm({ ...form, ...patch })
  const setExecutor = (name: ExecutorName, value: ExecutorSettings) => set({ executors: { ...form.executors, [name]: value } })
  const setAllowed = (name: ExecutorName, on: boolean) => {
    const allowed = new Set(form.allowedExecutors)
    if (on) allowed.add(name)
    else allowed.delete(name)
    set({ allowedExecutors: EXECUTORS.filter((n) => allowed.has(n)) })
  }
  const text = (field: keyof SettingsData, placeholder = '') => (
    <input value={String(form[field] ?? '')} placeholder={placeholder} onChange={(e) => set({ [field]: e.target.value } as Partial<SettingsData>)} />
  )

  return (
    <div className="page settings">
      <PageHeader title="设置" subtitle="项目绑定、执行器和发布说明。保存在本机，不会提交到任何仓库。" />
      <Section title="登录与连接" description="客户端用你自己的账号登录 AI PM 平台。Agent 不会拿到这份授权。">
        {snapshot.auth.mode === 'static' ? (
          <p className="hint">正在使用静态令牌（开发和测试用）。</p>
        ) : (
          <div className="row">
            {snapshot.auth.loggedIn && !snapshot.engine.authRequired
              ? <Badge tone="ok">已登录</Badge>
              : <Badge tone="warn">{snapshot.auth.loggedIn ? '登录已失效' : '未登录'}</Badge>}
            <Button icon={<KeyRound size={14} />} kind={snapshot.auth.loggedIn && !snapshot.engine.authRequired ? 'secondary' : 'primary'} disabled={!snapshot.configured || loggingIn}
              onClick={async () => {
                setLoggingIn(true)
                try {
                  await run(api.login(), '登录成功')
                } finally {
                  setLoggingIn(false)
                }
              }}>
              {loggingIn ? '请在浏览器里完成授权…' : snapshot.auth.loggedIn ? '重新登录' : '登录 AI PM 平台'}
            </Button>
            {!snapshot.configured && <span className="hint">先保存下面的项目设置</span>}
          </div>
        )}
        <div className="row">
          <Button icon={<PlugZap size={14} />} disabled={!snapshot.configured} onClick={async () => setProbe(await api.probe())}>测试连接（只读）</Button>
          <span className="hint">只读取项目信息、任务列表和订阅，不做任何写操作。</span>
        </div>
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
      </Section>

      <Section title="项目" description="要服务的 AI PM 项目和本地代码仓库。" aside={<Button small icon={<Download size={13} />} onClick={async () => {
        const legacy = await api.importLegacy()
        if (legacy) {
          setForm({ ...legacy, executors: { ...legacy.executors }, timing: form.timing })
          toast('已从旧客户端读取配置，检查后点保存')
        } else toast('没有找到旧客户端的配置', 'danger')
      }}>从旧客户端导入</Button>}>
        <div className="grid">
          <Field label="项目 ID">{text('projectId', 'prj_…')}</Field>
          <Field label="MCP 地址">{text('mcpUrl', 'http://…/mcp')}</Field>
          <Field label="订阅资源 URI">{text('resourceUri', 'ai-pm://projects/…/work')}</Field>
          <Field label="平台仓库地址" hint="用来核对本地仓库的 origin">{text('repository')}</Field>
          <Field label="本地仓库路径" hint="可以是仓库里的子目录，Agent 会在每个工作区的同一子目录里运行">{text('repoPath', '/Users/…/project')}</Field>
          <Field label="开发起始分支">{text('startRef', 'origin/main')}</Field>
        </div>
      </Section>

      {EXECUTORS.map((name) => (
        <ExecutorSection key={name} name={name} config={form.executors[name]} allowed={form.allowedExecutors.includes(name)}
          onChange={(value) => setExecutor(name, value)} onAllowed={(on) => setAllowed(name, on)} />
      ))}

      <Section title="发布说明" description="点“提测”或“上线”后，发布 Agent 按这里的说明决定是否合并、合到哪里、如何部署和验证。">
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
          暂停接新需求（已认领的任务继续推进）
        </label>
        <Field label="同时处理的需求上限" hint="包括等你处理和等平台的需求">
          <input type="number" min={1} value={form.maxOpenTasks} onChange={(e) => set({ maxOpenTasks: Number(e.target.value) })} />
        </Field>
        <Field label="完成后保留工作区的天数" hint="需求完成或关闭后，超过这个天数就删除它的本地工作区；有未提交改动的不删">
          <input type="number" min={1} value={form.worktreeRetentionDays ?? 14} onChange={(e) => set({ worktreeRetentionDays: Number(e.target.value) })} />
        </Field>
      </Section>

      <Section title="启动" description="关掉窗口后客户端继续在菜单栏运行。">
        <label className="check">
          <input type="checkbox" disabled={atLogin === null} checked={!!atLogin} onChange={async (e) => {
            const on = e.target.checked
            await api.setLaunchAtLogin(on)
            setAtLogin(await api.launchAtLogin())
          }} />
          登录 Mac 时自动启动（在菜单栏运行，不打开窗口）
        </label>
      </Section>

      <div className="save-bar">
        <Button kind="primary" icon={<Save size={14} />} onClick={() => run(api.saveSettings(form), '设置已保存')}>保存设置</Button>
        <span className="hint">修改项目绑定或执行器后，后台服务会重启；正在运行的 Agent 不受影响。</span>
      </div>
    </div>
  )
}
