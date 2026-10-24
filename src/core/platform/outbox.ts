import type { OutboxRow, Store } from '../store.js'
import type { Timing } from '../types.js'
import { PlatformError, type Platform, type TokenProvider } from './client.js'

export interface OutboxHandlers {
  onDone(item: OutboxRow, result: any): void
  onRejected(item: OutboxRow, error: PlatformError): void
  onHandlerError(item: OutboxRow, error: unknown): void
}

export function backoff(timing: Timing, attempts: number): number {
  return timing.backoffMs[Math.min(attempts, timing.backoffMs.length - 1)]
}

// Every platform write goes through here. The request_id is fixed when the item
// is enqueued, so a lost response is simply sent again and the platform dedupes it.
export class Outbox {
  authBlocked = false

  constructor(
    private readonly store: Store,
    private readonly platform: Platform,
    private readonly tokens: TokenProvider,
    private readonly timing: () => Timing,
    private readonly clock: () => number = Date.now,
  ) {}

  async flush(handlers: OutboxHandlers): Promise<void> {
    const waiting = new Set<string>()
    for (const item of this.store.pendingOutbox()) {
      if (waiting.has(item.taskKey)) continue
      if (item.nextAt > this.clock()) {
        waiting.add(item.taskKey)
        continue
      }
      let result: any
      try {
        result = await this.send(item)
      } catch (caught) {
        const error = caught instanceof PlatformError ? caught : new PlatformError('retryable', String(caught))
        if (error.kind === 'rejected') {
          this.store.outboxRejected(item.id, error.message)
          this.store.event(item.taskKey, 'platform_rejected', `${item.tool}: ${error.message}`)
          this.runHandler(item, () => handlers.onRejected(item, error), handlers)
        } else {
          this.store.outboxRetry(item.id, this.clock() + backoff(this.timing(), item.attempts), error.message)
          this.store.event(item.taskKey, 'platform_retry', `${item.tool}: ${error.message}`)
          waiting.add(item.taskKey)
          if (error.kind === 'auth') {
            this.authBlocked = true
            return
          }
        }
        continue
      }
      this.authBlocked = false
      this.store.outboxDone(item.id, result)
      this.runHandler(item, () => handlers.onDone(item, result), handlers)
    }
  }

  private runHandler(item: OutboxRow, fn: () => void, handlers: OutboxHandlers) {
    try {
      this.store.tx(fn)
    } catch (error) {
      handlers.onHandlerError(item, error)
    }
  }

  private async send(item: OutboxRow): Promise<any> {
    try {
      return await this.platform.call(item.tool, item.params)
    } catch (error) {
      if (!(error instanceof PlatformError) || error.kind !== 'auth') throw error
      await this.tokens.refresh()
      return this.platform.call(item.tool, item.params)
    }
  }
}
