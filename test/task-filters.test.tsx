import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Snapshot, TaskView } from '../src/shared/api.js'
import { occupiesTaskCapacity } from '../src/shared/task-status.js'
import { TASK_FILTERS, Tasks } from '../src/renderer/pages/Tasks.js'
import { displayState, groupTaskRows, taskKindLabel } from '../src/renderer/model.js'

const task = (status: TaskView['status'], reason: string | null = null, kind: TaskView['kind'] = 'task') =>
  ({ key: `${kind}:${status}:${reason}`, title: `${status}-${reason}`, platformId: reason ?? status, kind, status, reason, stage: 'release', executor: 'codex', failures: 0 }) as TaskView

describe('task capacity and list categories', () => {
  const acceptance = task('waiting', 'acceptance')
  const active = [task('queued'), task('running'), task('needs_you', 'ready_to_release'), task('waiting', 'testing'), task('waiting', 'aligning'), task('waiting', 'syncing'), task('waiting', 'in_batch'), task('queued', null, 'collaboration')]
  const all = [...active, acceptance, task('done', 'acceptance'), task('closed'), task('running', null, 'batch')]

  it('keeps pending work in capacity and puts only waiting acceptance in its separate category', () => {
    expect(all.filter(occupiesTaskCapacity)).toEqual(active)
    expect(all.filter((t) => TASK_FILTERS.find((f) => f.id === 'active')!.match(t, all))).toEqual(active)
    expect(all.filter((t) => TASK_FILTERS.find((f) => f.id === 'acceptance')!.match(t, all))).toEqual([acceptance])
    expect(TASK_FILTERS.find((f) => f.id === 'all')!.match(acceptance, all)).toBe(true)
  })

  it('shows a separate acceptance count and excludes its row from the default active list', () => {
    const html = renderToStaticMarkup(<Tasks snapshot={{ tasks: all, projects: [] } as unknown as Snapshot} go={() => {}} />)
    expect(html).toContain('待验收<span class="count">1</span>')
    expect(html).toContain('进行中<span class="count">8</span>')
    expect(html).not.toContain('waiting-acceptance')
    expect(html).toContain('waiting-testing')
  })

  it('labels synchronization and execution alarms independently', () => {
    const html = renderToStaticMarkup(<Tasks snapshot={{ tasks: [{ ...task('queued'), failures: 3, syncIssue: { failures: 2, message: 'timeout', at: '' } }], projects: [] } as unknown as Snapshot} go={() => {}} />)
    expect(html).toContain('同步异常')
    expect(html).toContain('执行异常')
  })
})

describe('linked test Bugs', () => {
  const parent = { ...task('waiting', 'testing'), key: 'task:parent', platformId: 'parent', title: '批量调价', project: 'main', platformStatus: 'fixing' }
  const child = { ...task('needs_you', 'plan_confirm'), key: 'task:bug', platformId: 'bug', title: '针对设计优化', project: 'main', taskType: 'bug', parentRequirement: { id: 'parent', key: parent.key, title: parent.title } } as TaskView
  const other = { ...task('running'), key: 'task:other', platformId: 'other', title: '无关需求', project: 'main' }

  it('groups a newer Bug under its parent while retaining both states and counting each task once', () => {
    const html = renderToStaticMarkup(<Tasks snapshot={{ tasks: [child, other, parent], projects: [] } as unknown as Snapshot} go={() => {}} />)
    expect(html.indexOf('批量调价')).toBeLessThan(html.indexOf('针对设计优化'))
    expect(html.indexOf('针对设计优化')).toBeLessThan(html.indexOf('无关需求'))
    expect(html).toContain('关联测试 Bug · bug')
    expect(html).toContain('等待关联 Bug 修复')
    expect(html).toContain('方案待确认')
    expect(html).toContain('进行中<span class="count">3</span>')
    expect(html.match(/class="task-child"/g)).toHaveLength(1)
  })

  it('shows the parent as context when filtering or searching for a child, and finds children by parent title', () => {
    const needs = (t: TaskView) => t.status === 'needs_you'
    const all = [child, other, parent]
    expect(groupTaskRows(all, needs)).toEqual([{ parent, relation: child.parentRequirement, children: [child], contextOnly: true }])
    expect(groupTaskRows(all, () => true, 'BUG')[0]).toMatchObject({ parent, children: [child], contextOnly: true })
    expect(groupTaskRows(all, () => true, '批量调价')[0]).toMatchObject({ parent, children: [child], contextOnly: false })
    expect(groupTaskRows(all, () => true, '不存在')).toEqual([])
    const done = { ...parent, status: 'done' } as TaskView
    expect(groupTaskRows([child, done], occupiesTaskCapacity)[0]).toMatchObject({ parent: done, contextOnly: true })
  })

  it('keeps missing parents and same-number tasks in other projects distinct', () => {
    const all = [child, { ...parent, project: 'other' }]
    const groups = groupTaskRows(all, () => true)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ parent: null, children: [child] })
    const html = renderToStaticMarkup(<Tasks snapshot={{ tasks: [child], projects: [] } as unknown as Snapshot} go={() => {}} />)
    expect(html).toContain('所属需求 · 批量调价')
    expect(html).toContain('未在本机领取')
    expect(taskKindLabel({ ...child, parentRequirement: null })).toBe('Bug')
    expect(taskKindLabel(other)).toBe('需求')
  })

  it('distinguishes fixing, retest, verification and ordinary testing without changing the task state', () => {
    for (const [platformStatus, label] of [['fixing', '等待关联 Bug 修复'], ['retest', '待复测'], ['verifying', '待验证'], ['testing', '产品测试中']]) {
      expect(displayState({ ...parent, platformStatus }, [])).toMatchObject({ label, live: false, needsYou: false })
    }
    expect(displayState({ ...parent, status: 'running' }, []).label).toBe('运行中')
    expect(displayState({ ...parent, taskType: 'bug' }, []).label).toBe('修复中')
  })
})
