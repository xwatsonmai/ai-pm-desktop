import type { ExecutorName } from './types.js'

// Executor slots belong to the machine, not to a project: every project's
// scheduler counts against the same limits. A scheduler reserves a slot while it
// prepares a run, so two projects starting at once cannot both take the last one.
export class Slots {
  private readonly counters = new Set<(executor: ExecutorName) => number>()
  private readonly reserved = new Map<ExecutorName, number>()

  // `running` counts one scheduler's running tasks on an executor. Returns the undo.
  register(running: (executor: ExecutorName) => number): () => void {
    this.counters.add(running)
    return () => this.counters.delete(running)
  }

  inUse(executor: ExecutorName): number {
    let total = this.reserved.get(executor) ?? 0
    for (const running of this.counters) total += running(executor)
    return total
  }

  // Held until the run shows up as running, or did not start. Returns the release.
  reserve(executor: ExecutorName): () => void {
    this.reserved.set(executor, (this.reserved.get(executor) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.reserved.set(executor, (this.reserved.get(executor) ?? 1) - 1)
    }
  }
}
