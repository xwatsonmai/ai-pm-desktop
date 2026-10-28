import { useEffect, useState } from 'react'
import type { ProjectBinding, ProjectSettings } from '../../shared/api.js'
import { api } from '../api.js'
import { Badge, Button, Section, useToast } from './ui.js'

export const DEFAULT_PLATFORM_ENTRY = 'https://portal.shiyugame.com/syai/zhiqu/'

const labels = { projectId: '项目 ID', mcpUrl: 'MCP 地址', resourceUri: '订阅资源 URI', repository: '平台仓库地址' } as const

export function ProjectConnection({ id, form, set, binding, onBinding, defaultEntry }: {
  id?: string; form: ProjectSettings; set: (patch: Partial<ProjectSettings>) => void
  binding: ProjectBinding | null; onBinding: (value: ProjectBinding) => void; defaultEntry?: string
}) {
  const toast = useToast()
  const [entry, setEntry] = useState(form.mcpUrl || defaultEntry || DEFAULT_PLATFORM_ENTRY)
  const [connecting, setConnecting] = useState(false)
  const [checked, setChecked] = useState<string | null>(null)
  useEffect(() => setChecked(null), [form.repoPath, form.repository, form.startRef])
  const ready = !!id || !!binding
  const connect = async () => {
    setConnecting(true)
    try {
      const result = await api.discoverProject(id ? form.mcpUrl : entry, id)
      if (!result.ok) return toast(result.message, 'danger')
      const metadata = result.value
      // Existing checkouts retain their explicit development base and local settings.
      set({ projectId: metadata.projectId, mcpUrl: metadata.mcpUrl, resourceUri: metadata.resourceUri,
        repository: metadata.repository, startRef: id ? form.startRef || metadata.startRef : metadata.startRef })
      if (!id) onBinding(metadata)
      toast(id ? '已读取平台信息，检查后保存；当前开发分支已保留' : '授权成功，已自动读取项目配置')
    } finally { setConnecting(false) }
  }
  return <>
    {!id && <Section title="1 · 连接平台" description="输入平台入口，在浏览器里登录并选择要授权的项目。完成绑定前不会领取任务。">
      <label className="field"><span className="field-label">平台地址</span>
        <input value={entry} disabled={connecting} placeholder={DEFAULT_PLATFORM_ENTRY} onChange={(e) => setEntry(e.target.value)} />
      </label>
      <Button kind="primary" disabled={connecting || !entry.trim()} onClick={connect}>
        {connecting ? '请在浏览器里登录并选择项目…' : ready ? '重新连接并选择项目' : '登录并选择项目'}
      </Button>
    </Section>}
    {ready && <>
      <Section title={id ? '项目绑定' : '2 · 已读取项目'} description="项目和订阅信息来自授权的平台，Agent 不会拿到平台授权。">
        <div className="row"><strong>{binding?.name ?? form.projectId}</strong><Badge tone="ok">{id ? '已绑定' : '已授权，尚未加入调度'}</Badge>
          {id && <Button small onClick={connect} disabled={connecting}>从平台更新（只读）</Button>}
        </div>
        <details><summary>查看平台绑定信息</summary><div className="grid">
          {Object.entries(labels).map(([key, label]) => <label className="field" key={key}><span className="field-label">{label} · 自动获取</span><input readOnly value={String(form[key as keyof ProjectSettings] ?? '')} /></label>)}
        </div></details>
      </Section>
      <Section title={id ? '本地仓库' : '3 · 选择本地仓库并校验'} description="可以选择仓库内的子目录，Agent 会在每个工作区的相同子目录中运行。">
        <label className="field"><span className="field-label">本地仓库路径</span><div className="row">
          <input value={form.repoPath} placeholder="选择本地代码仓库" onChange={(e) => set({ repoPath: e.target.value })} />
          <Button onClick={async () => { const path = await api.chooseRepository(); if (path) set({ repoPath: path }) }}>选择目录</Button>
        </div></label>
        <p className="hint">开发起始分支：{form.startRef}</p>
        <details><summary>高级设置 · 覆盖开发起始分支</summary>
          <label className="field"><span className="field-label">开发起始分支</span><input value={form.startRef} onChange={(e) => set({ startRef: e.target.value })} /></label>
          <p className="hint">默认使用平台配置的分支，保存时校验本地引用，不切换当前工作分支。</p>
        </details>
        <div className="row"><Button disabled={!form.repoPath.trim()} onClick={async () => {
          const result = await api.checkRepository(form)
          setChecked(result.ok ? `校验通过：origin 与平台仓库一致，${result.value.branch} 可用` : null)
          if (!result.ok) toast(result.message, 'danger')
        }}>校验仓库和分支</Button>{checked && <span className="hint ok">{checked}</span>}</div>
      </Section>
    </>}
  </>
}
