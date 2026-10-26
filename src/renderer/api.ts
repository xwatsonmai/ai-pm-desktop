import type { Api, CommandName, Result, Route } from '../shared/api.js'

interface Bridge {
  invoke(method: string, ...args: unknown[]): Promise<unknown>
  on(channel: 'changed' | 'navigate', listener: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    api: Bridge
  }
}

// Typed calls into the main process: api.snapshot(), api.detail(key), …
export const api = new Proxy({} as Api, {
  get: (_target, method: string) => (...args: unknown[]) => window.api.invoke(method, ...args),
})

export const onChanged = (listener: () => void) => window.api.on('changed', () => listener())
export const onNavigate = (listener: (route: Route) => void) => window.api.on('navigate', (route) => listener(route as Route))

export function command(name: CommandName, ...args: unknown[]): Promise<Result<unknown>> {
  return api.command(name, args)
}

// Pausing always works; resuming can be refused when the platform check fails.
export function setIntake(project: string | null, paused: boolean): Promise<Result<unknown>> {
  return api.setIntakePaused(project, paused).then(
    () => ({ ok: true as const, value: undefined }),
    (error: unknown) => ({ ok: false as const, code: 'intake_refused', message: String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }),
  )
}
