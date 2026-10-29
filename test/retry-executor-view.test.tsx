import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProblemCard } from '../src/renderer/pages/NeedsYou.js'
import { ExecutorsContext } from '../src/renderer/components/Review.js'
import type { TaskView } from '../src/shared/api.js'

const task = { key: 'task:1', kind: 'task', platformId: '1', title: '失败任务', stage: 'plan', status: 'needs_you', reason: 'executor_failing', detail: 'Select a model', executor: 'zcode', updatedAt: new Date().toISOString() } as TaskView
const render = (value = task) => renderToStaticMarkup(<ExecutorsContext.Provider value={[
  { name: 'codex', configured: true, enabled: true, busy: 0, limit: 1, healthy: null, expertModel: 'current-model' },
  { name: 'zcode', configured: true, enabled: true, busy: 0, limit: 1, healthy: null, expertModel: null },
  { name: 'claude', configured: false, enabled: false, busy: 0, limit: 0, healthy: null, expertModel: null },
]}><ProblemCard task={value} go={() => {}} /></ExecutorsContext.Provider>)

describe('retry executor choice', () => {
  it('offers configured executors and explains session handoff and slot queueing', () => {
    const html = render()
    expect(html).toContain('重试执行器')
    expect(html).toContain('<option value="codex">Codex</option>')
    expect(html).toContain('<option value="zcode" selected="">ZCode（当前）</option>')
    expect(html).not.toContain('value="claude"')
    expect(html).toContain('没有空闲名额时排队等待')
  })
  it('does not offer reassignment for platform operation rejection', () => {
    const html = render({ ...task, reason: 'platform_rejected' })
    expect(html).not.toContain('重试执行器')
    expect(html).not.toContain('<select')
    expect(html).toContain('重试')
  })
})
