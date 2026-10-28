import type { Kind, Status } from '../core/types.js'

type TaskState = { kind: Kind; status: Status; reason: string | null }

// Acceptance still needs platform synchronization, but no longer holds intake
// capacity. A return to development automatically counts again.
export const isAwaitingAcceptance = (task: TaskState): boolean =>
  task.kind === 'task' && task.status === 'waiting' && task.reason === 'acceptance'

export const occupiesTaskCapacity = (task: TaskState): boolean =>
  task.kind !== 'batch' && ['queued', 'running', 'needs_you', 'waiting'].includes(task.status) && !isAwaitingAcceptance(task)
