import { expect, it } from 'vitest'
import type { Task } from '../src/core/types.js'
import { supersedingRelease } from '../src/main/release-history.js'
const batch = (key: string, patch: Partial<Task> = {}) => ({
  key, kind: 'batch', stage: 'test_release', status: 'closed', createdAt: '2026-10-29T03:00:00.000Z',
  data: { members: ['task:a'], release: { outcome: 'failed' } }, ...patch,
}) as Task
const failed = batch('batch:old')
const success = (patch: Partial<Task> = {}) => batch('batch:new', {
  status: 'done', createdAt: '2026-10-29T03:10:00.000Z',
  data: { members: ['task:a'], release: { outcome: 'success' } }, ...patch,
})
it('resolves a closed failure only after a later success of the same stage', () => {
  expect(supersedingRelease(failed, [failed, success()])?.key).toBe('batch:new')
  for (const candidate of [success({ status: 'running' }), success({ stage: 'release' }), success({ createdAt: failed.createdAt }), success({ data: { members: ['task:a'], release: { outcome: 'partial' } } })]) {
    expect(supersedingRelease(failed, [failed, candidate])).toBeUndefined()
  }
  expect(supersedingRelease(batch('batch:active', { status: 'needs_you' }), [success()])).toBeUndefined()
})
it('requires coverage of every original member and accepts a later combined release', () => {
  expect(supersedingRelease(failed, [success({ data: { members: ['task:b'], release: { outcome: 'success' } } })])).toBeUndefined()
  const combined = success({ data: { members: ['task:a', 'task:b'], release: { outcome: 'success' } } })
  expect(supersedingRelease(failed, [combined])?.key).toBe(combined.key)
  expect(supersedingRelease(batch('batch:both', { data: { members: ['task:a', 'task:b'] } }), [success()])).toBeUndefined()
  expect(supersedingRelease(batch('batch:empty', { data: {} }), [success()])).toBeUndefined()
})
