import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Snapshot, TaskView } from '../src/shared/api.js'
import { occupiesTaskCapacity } from '../src/shared/task-status.js'
import { TASK_FILTERS, Tasks } from '../src/renderer/pages/Tasks.js'

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
