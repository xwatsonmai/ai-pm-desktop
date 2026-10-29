import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectSwitcher, UnsavedChangesDialog } from '../src/renderer/App.js'
import { ProjectExecutors } from '../src/renderer/pages/Settings.js'
import { workspaceApi } from '../src/renderer/api.js'
import type { ProjectSettings, Snapshot } from '../src/shared/api.js'

const snapshot = { projects: [
  { id: 'a', name: '订单系统', counts: { needs: 0, running: 1, active: 2 } },
  { id: 'b', name: '会员系统', counts: { needs: 2, running: 0, active: 3 } },
] } as Snapshot

afterEach(() => vi.unstubAllGlobals())

describe('workspace interface', () => {
  it('offers explicit stay and discard actions for unsaved settings in an accessible app dialog', () => {
    const html = renderToStaticMarkup(<UnsavedChangesDialog onStay={() => {}} onDiscard={() => {}} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('留在此页')
    expect(html).toContain('放弃修改并离开')
  })

  it('shows the selected workspace and other project notification counts in one switcher', () => {
    const html = renderToStaticMarkup(<ProjectSwitcher snapshot={snapshot} selected="a" onSelect={() => {}} onAdd={() => {}} />)
    expect(html).toContain('aria-label="切换项目工作区"')
    expect(html).toContain('<option value="a" selected="">订单系统</option>')
    expect(html).toContain('会员系统 · 2 待处理')
    expect(html).toContain('＋ 添加项目')
  })

  it('shows project enablement separately from shared model configuration and allows an empty policy', () => {
    const html = renderToStaticMarkup(<ProjectExecutors form={{ allowedExecutors: [] } as unknown as ProjectSettings} set={() => {}} go={() => {}} globals={{ executors: { codex: { binary: '/codex', limit: 3, models: { expert: { model: 'expert' }, execution: { model: 'execution' } } } } }} />)
    expect(html).toContain('本项目执行器')
    expect(html).toContain('专家：expert · 执行：execution')
    expect(html).toContain('本项目不会领取新任务')
    expect(html).toContain('尚未配置，请先到客户端配置添加')
    expect(html).not.toContain('checked=""')
    expect(html).not.toContain('程序路径')
    expect(html).not.toContain('type="number"')
  })

  it('binds command, detail, diff and log calls to the workspace that created them', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('window', { api: { invoke } })
    const old = workspaceApi('a')
    const current = workspaceApi('b')
    await current.command('retry', 'task:same', 'codex')
    // A late callback from the previous page must still name A explicitly.
    await old.command('retry', 'task:same', 'zcode')
    await old.detail('task:same')
    await old.diff('task:same')
    await old.runLog('run', 12)
    expect(invoke.mock.calls).toEqual([
      ['command', 'b', 'retry', ['task:same', 'codex']],
      ['command', 'a', 'retry', ['task:same', 'zcode']],
      ['detail', 'a', 'task:same'], ['diff', 'a', 'task:same'], ['runLog', 'a', 'run', 12],
    ])
    expect(await workspaceApi(null).command('retry', 'task:same')).toMatchObject({ ok: false, code: 'no_project' })
    expect(invoke).toHaveBeenCalledTimes(5)
  })
})
