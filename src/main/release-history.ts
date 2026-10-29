import type { Task } from '../core/types.js'

// A closed release's retained conflict checkout stops being an actionable
// warning once a later successful release of the same stage covers its members.
// This changes presentation only: keep files, history and cleanup protections.
export function supersedingRelease(task: Task, all: Iterable<Task>): Task | undefined {
  const members = task.data.members ?? []
  if (task.kind !== 'batch' || task.status !== 'closed' || !members.length) return undefined
  return [...all].filter((candidate) =>
    candidate.kind === 'batch' && candidate.stage === task.stage &&
    candidate.status === 'done' && candidate.data.release?.outcome === 'success' &&
    candidate.createdAt > task.createdAt &&
    members.every((key) => candidate.data.members?.includes(key)),
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}
