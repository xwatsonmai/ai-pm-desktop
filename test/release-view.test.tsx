import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/shared/api.js'
import { ownerOf } from '../src/renderer/pages/TaskDetail.js'

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
