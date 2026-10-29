import { createContext, useContext } from 'react'
import type { ProjectView, TaskView } from '../shared/api.js'

// The projects being served. With just one, nothing needs to say which project a task is in.
export const WorkspaceIdContext = createContext<string | null>(null)

export const ProjectsContext = createContext<ProjectView[]>([])

// The project name to show next to a task, or null when there is only one project.
export function useProjectName(task: TaskView | undefined): string | null {
  const projects = useContext(ProjectsContext)
  if (!task || projects.length < 2) return null
  return projects.find((p) => p.id === task.project)?.name ?? task.project
}
