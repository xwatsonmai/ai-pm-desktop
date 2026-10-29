import { useContext, useMemo } from 'react'
import { WorkspaceIdContext } from './projects.js'
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

// Bound to the workspace that rendered the action, never a mutable global id.
// A late reply or click during a project switch cannot act on the new project.
export function workspaceApi(project: string | null) {
  return {
    command: (name: CommandName, ...args: unknown[]): Promise<Result<unknown>> => project
      ? api.command(project, name, args)
      : Promise.resolve({ ok: false, code: 'no_project', message: '请先选择项目' }),
    detail: (key: string) => api.detail(project!, key),
    diff: (key: string) => api.diff(project!, key),
    runLog: (run: string, offset: number) => api.runLog(project!, run, offset),
  }
}

export function useWorkspaceApi() {
  const project = useContext(WorkspaceIdContext)
  return useMemo(() => workspaceApi(project), [project])
}

// Pausing always works; resuming can be refused when the platform check fails.
export function setIntake(project: string | null, paused: boolean): Promise<Result<unknown>> {
  return api.setIntakePaused(project, paused).then(
    () => ({ ok: true as const, value: undefined }),
    (error: unknown) => ({ ok: false as const, code: 'intake_refused', message: String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }),
  )
}
