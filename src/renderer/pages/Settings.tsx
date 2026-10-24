import { useEffect, useState, type ReactNode } from 'react'
import type { ExecutorSettings } from '../../core/types.js'
import type { ProbeStep, Settings as SettingsData, Snapshot } from '../../shared/api.js'
import { api } from '../api.js'
import { CircleCheck, CircleX, Download, KeyRound, PlugZap, Save, ScanSearch } from 'lucide-react'
import { Badge, Button, PageHeader, Section, useRun, useToast } from '../components/ui.js'

const EMPTY: SettingsData = {
  projectId: '', mcpUrl: '', resourceUri: '', repository: '', repoPath: '', startRef: 'origin/main',
  executors: { codex: { binary: '', limit: 1 } }, allowedExecutors: ['codex'], testReleaseInstructions: '',
  releaseInstructions: '', maxOpenTasks: 5, intakePaused: true,
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh']

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
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
  const codex: ExecutorSettings = form.executors.codex ?? { binary: '', limit: 1 }
  const setCodex = (patch: Partial<ExecutorSettings>) => set({ executors: { ...form.executors, codex: { ...codex, ...patch } } })
  const model = (role: 'expert' | 'execution') => codex.models?.[role] ?? {}
  const setModel = (role: 'expert' | 'execution', patch: { model?: string; effort?: string }) => {
    const next = { ...model(role), ...patch }
    setCodex({ models: { ...codex.models, [role]: { model: next.model || undefined, effort: next.effort || undefined } } })
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

      <Section title="执行器 · Codex" description="Agent 在你的电脑上以子进程运行，每个需求一个独立的 git worktree。">
        <div className="grid">
          <Field label="程序路径">
            <div className="row">
              <input value={codex.binary} onChange={(e) => setCodex({ binary: e.target.value })} />
              <Button small icon={<ScanSearch size={13} />} onClick={async () => {
                const found = await api.detectCodex()
                if (found) setCodex({ binary: found })
                else toast('没有找到 codex，请手动填写路径', 'danger')
              }}>自动探测</Button>
            </div>
          </Field>
          <Field label="同时运行的名额" hint="1 到 8；调低不会打断正在运行的任务">
            <input type="number" min={1} max={8} value={codex.limit} onChange={(e) => setCodex({ limit: Number(e.target.value) })} />
          </Field>
          {(['expert', 'execution'] as const).map((role) => (
            <Field key={role} label={role === 'expert' ? '专家模型（方案、协同）' : '执行模型（开发、修复、发布）'} hint="留空则使用 Codex 默认值">
              <div className="row">
                <input placeholder="模型 ID" value={model(role).model ?? ''} onChange={(e) => setModel(role, { model: e.target.value })} />
                <select value={model(role).effort ?? ''} onChange={(e) => setModel(role, { effort: e.target.value })}>
                  <option value="">默认强度</option>
                  {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
            </Field>
          ))}
          <label className="check">
            <input type="checkbox" checked={codex.isolateUserConfig !== false} onChange={(e) => setCodex({ isolateUserConfig: e.target.checked })} />
            不加载 Codex 用户配置（推荐）：Agent 会话不会接触你配置里的 MCP 服务，包括 AI PM 平台
          </label>
          <Field label="Codex 配置覆盖" hint="每行一条 key=value（TOML 写法），作为 -c 传给 Codex。例如给 Agent 加一个运营查询的 MCP 服务">
            <textarea rows={3} spellCheck={false} value={(codex.configOverrides ?? []).join('\n')}
              onChange={(e) => setCodex({ configOverrides: e.target.value.split('\n') })} />
          </Field>
        </div>
        <p className="hint">Claude Code 和 ZCode 会在下一个阶段接入。</p>
      </Section>

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
