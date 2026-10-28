import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ProjectConnection } from '../src/renderer/components/ProjectBinding.js'
import type { ProjectBinding, ProjectSettings } from '../src/shared/api.js'

const form = { projectId: '', mcpUrl: '', resourceUri: '', repository: '', repoPath: '', startRef: '' } as ProjectSettings
const binding: ProjectBinding = { ticket: 'private-local-ticket', name: '订单系统', projectId: 'prj_orders', mcpUrl: 'https://example.com/sub/mcp', resourceUri: 'ai-pm://projects/prj_orders/work', repository: 'https://example.com/repo.git', startRef: 'origin/main' }

it('starts with only a platform entry and authorization instead of requiring project identifiers', () => {
  const html = renderToStaticMarkup(<ProjectConnection form={form} set={() => {}} binding={null} onBinding={() => {}} />)
  expect(html).toContain('登录并选择项目')
  expect(html).toContain('平台地址')
  expect(html).not.toContain('项目 ID')
  expect(html).not.toContain('本地仓库路径')
})

it('shows discovered binding data as read-only and offers local repository validation and a branch override', () => {
  const html = renderToStaticMarkup(<ProjectConnection form={{ ...form, ...binding }} set={() => {}} binding={binding} onBinding={() => {}} />)
  expect(html).toContain('订单系统')
  expect(html).toContain('尚未加入调度')
  expect(html).toContain('readOnly="" value="prj_orders"')
  expect(html).toContain('选择目录')
  expect(html).toContain('校验仓库和分支')
  expect(html).toContain('高级设置 · 覆盖开发起始分支')
  expect(html).not.toContain('private-local-ticket')
})
