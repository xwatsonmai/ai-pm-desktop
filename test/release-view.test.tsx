import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/shared/api.js'
import { ownerOf } from '../src/renderer/pages/TaskDetail.js'
import { displayState } from '../src/renderer/model.js'

const view = (key: string, members: string[] = []) =>
  ({ key, kind: members.length ? 'batch' : 'task', members: members.map((m) => ({ key: m, title: m, platformId: m })) }) as unknown as TaskView

describe('release shown with its requirement', () => {
  it('opens a one-requirement release as that requirement', () => {
    const all = [view('task:a'), view('task:b'), view('batch:1', ['task:a']), view('batch:2', ['task:a', 'task:b'])]
    expect(ownerOf('batch:1', all)).toBe('task:a')
    expect(ownerOf('batch:2', all)).toBe('batch:2')
    expect(ownerOf('task:b', all)).toBe('task:b')
    expect(ownerOf('batch:gone', all)).toBe('batch:gone')
  })
})

describe('a release that has not started', () => {
  const member = { key: 'task:a', kind: 'task', reason: 'in_batch', batch: 'batch:1', status: 'waiting' } as unknown as TaskView
  const batch = (patch: object) => ({ key: 'batch:1', kind: 'batch', stage: 'release', status: 'queued', lastError: null, members: [], ...patch }) as unknown as TaskView

  it('says so on its requirement instead of claiming to be under way', () => {
    expect(displayState(member, [member, batch({ lastError: 'git fetch --quiet origin: Connection closed' })])).toMatchObject({ label: '上线未开始', tone: 'danger', live: false })
    expect(displayState(member, [member, batch({})])).toMatchObject({ label: '上线中', live: false })
    expect(displayState(member, [member, batch({ status: 'running' })])).toMatchObject({ label: '上线中', live: true })
  })
})
