import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Clip,
  CutMethod,
  CutPreview,
  ExportRequest,
  ExportSettings,
  ExportStatus,
  JobStatus,
  Place,
  Project,
  ProjectSummary,
  Suggestions
} from '../shared/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  setupError: (): Promise<string | null> => ipcRenderer.invoke('app:setup'),
  listProjects: (): Promise<ProjectSummary[]> => ipcRenderer.invoke('projects:list'),
  getProject: (id: string): Promise<Project> => ipcRenderer.invoke('projects:get', id),
  addRips: (): Promise<{ added: Project[]; errors: string[] }> => ipcRenderer.invoke('projects:add'),
  addPaths: (paths: string[]): Promise<{ added: Project[]; errors: string[] }> =>
    ipcRenderer.invoke('projects:addPaths', paths),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  renameProject: (id: string, name: string): Promise<void> => ipcRenderer.invoke('projects:rename', id, name),
  deleteProject: (id: string): Promise<boolean> => ipcRenderer.invoke('projects:delete', id),
  relinkProject: (id: string): Promise<Project> => ipcRenderer.invoke('projects:relink', id),
  saveClips: (id: string, clips: Clip[]): Promise<void> => ipcRenderer.invoke('clips:save', id, clips),
  suggestions: (): Promise<Suggestions> => ipcRenderer.invoke('suggestions:get'),
  searchPlaces: (query: string): Promise<Place[]> => ipcRenderer.invoke('places:search', query),
  saveExportSettings: (id: string, settings: ExportSettings): Promise<void> =>
    ipcRenderer.invoke('export:settings', id, settings),
  previewCuts: (id: string, method: CutMethod | null): Promise<Record<string, CutPreview>> =>
    ipcRenderer.invoke('export:preview', id, method),
  pickFolder: (current: string | null): Promise<string | null> => ipcRenderer.invoke('export:pickFolder', current),
  startExport: (request: ExportRequest): Promise<void> => ipcRenderer.invoke('export:start', request),
  cancelExport: (): Promise<void> => ipcRenderer.invoke('export:cancel'),
  exportStatus: (): Promise<ExportStatus | null> => ipcRenderer.invoke('export:status'),
  jobs: (): Promise<JobStatus[]> => ipcRenderer.invoke('jobs:status'),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),
  onProjects: (listener: (summaries: ProjectSummary[]) => void) => subscribe('projects:changed', listener),
  onProject: (listener: (project: Project) => void) => subscribe('project:changed', listener),
  onJobs: (listener: (jobs: JobStatus[]) => void) => subscribe('jobs:changed', listener),
  onExport: (listener: (status: ExportStatus) => void) => subscribe('export:changed', listener),
  onSuggestions: (listener: (suggestions: Suggestions) => void) => subscribe('suggestions:changed', listener)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
