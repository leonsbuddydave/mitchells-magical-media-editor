import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { Clip, ExportRequest, ExportSettings, CutMethod, Project } from '../shared/types'
import { AnalysisQueue, filmstripDir, needsProxy, proxyPath } from './analysis'
import { Exporter, previewCuts } from './exporter'
import { binaries } from './ffmpeg'
import { searchPlaces } from './places'
import { probeMedia } from './probe'
import { Store } from './store'

if (process.env.MME_USER_DATA) app.setPath('userData', process.env.MME_USER_DATA)

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
])

const VIDEO_EXTENSIONS = ['avi', 'dv', 'mkv', 'mov', 'mp4', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', 'vob', 'wmv', 'webm']
const CONTENT_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.jpg': 'image/jpeg' }

let window: BrowserWindow | null = null
let store: Store
let queue: AnalysisQueue
let exporter: Exporter

function placesHelper(): string {
  if (process.env.MME_PLACES_HELPER) return process.env.MME_PLACES_HELPER
  return app.isPackaged ? join(process.resourcesPath, 'places') : join(app.getAppPath(), 'native', 'build', 'places')
}

function send(channel: string, payload: unknown): void {
  window?.webContents.send(channel, payload)
}

function publish(project: Project): void {
  send('project:changed', project)
  send('projects:changed', store.summaries())
}

function fileResponse(path: string, request: Request): Response {
  if (!existsSync(path)) return new Response('Not found', { status: 404 })
  const size = statSync(path).size
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '')
  if (!range) {
    const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
    })
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start >= size || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  const stream = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream
  return new Response(stream, {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes'
    }
  })
}

/** Serves only files belonging to a known project, never an arbitrary path. */
function handleMedia(request: Request): Response {
  const url = new URL(request.url)
  const [id, file] = url.pathname.split('/').filter(Boolean)
  if (!id || !store.has(id)) return new Response('Not found', { status: 404 })
  const project = store.get(id)
  if (url.hostname === 'video') {
    return fileResponse(project.analysis.needsProxy ? proxyPath(store, id) : project.sourcePath, request)
  }
  if (url.hostname === 'filmstrip' && file && /^sheet-\d+\.jpg$/.test(file)) {
    return fileResponse(join(filmstripDir(store, id), file), request)
  }
  return new Response('Not found', { status: 404 })
}

async function addRips(paths: string[]): Promise<{ added: Project[]; errors: string[] }> {
  const added: Project[] = []
  const errors: string[] = []
  for (const path of paths) {
    const existing = store.findBySource(path)
    if (existing) {
      added.push(existing)
      continue
    }
    try {
      const project = await store.create(path)
      queue.enqueue(project)
      added.push(project)
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  send('projects:changed', store.summaries())
  return { added, errors }
}

function registerIpc(): void {
  ipcMain.handle('projects:list', () => store.summaries())
  ipcMain.handle('projects:get', (_event, id: string) => {
    const project = store.get(id)
    queue.prioritize(id)
    return project
  })
  ipcMain.handle('projects:add', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Add rips',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }, { name: 'All files', extensions: ['*'] }]
    })
    return addRips(result.canceled ? [] : result.filePaths)
  })
  ipcMain.handle('projects:addPaths', (_event, paths: string[]) => addRips(paths))
  ipcMain.handle('projects:rename', async (_event, id: string, name: string) => {
    const project = store.get(id)
    project.name = name.trim() || project.name
    await store.save(project)
    publish(project)
  })
  ipcMain.handle('projects:delete', async (_event, id: string) => {
    const project = store.get(id)
    const { response } = await dialog.showMessageBox(window!, {
      type: 'warning',
      buttons: ['Remove Project', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Remove "${project.name}"?`,
      detail: 'Your clip marks and tags for this rip will be deleted. The rip itself and any exported clips stay where they are.'
    })
    if (response !== 0) return false
    queue.cancel(id)
    await store.delete(id)
    send('projects:changed', store.summaries())
    return true
  })
  ipcMain.handle('projects:relink', async (_event, id: string) => {
    const project = store.get(id)
    const result = await dialog.showOpenDialog(window!, {
      title: `Locate ${project.name}`,
      properties: ['openFile']
    })
    if (result.canceled) return project
    const [path] = result.filePaths
    const media = await probeMedia(path)
    if (media.video.codec !== project.media.video.codec || Math.abs(media.duration - project.media.duration) > 1) {
      const { response } = await dialog.showMessageBox(window!, {
        type: 'warning',
        buttons: ['Use Anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'This does not look like the same rip.',
        detail: 'Its codec or length differs, so existing clip marks may point at the wrong video.'
      })
      if (response !== 0) return project
      project.analysis = { packets: null, needsProxy: null, proxyReady: false, filmstrip: null, scenes: [], error: null }
    }
    project.sourcePath = path
    project.sourceMissing = false
    project.media = media
    if (project.analysis.packets) {
      project.analysis.needsProxy = needsProxy(media, project.analysis.firstFrameOffset ?? 0)
    }
    await store.save(project)
    queue.enqueue(project)
    publish(project)
    return project
  })
  ipcMain.handle('clips:save', async (_event, id: string, clips: Clip[]) => {
    const project = store.get(id)
    project.clips = clips
    await store.save(project)
    send('projects:changed', store.summaries())
    send('suggestions:changed', store.suggestions())
  })
  ipcMain.handle('suggestions:get', () => store.suggestions())
  ipcMain.handle('places:search', (_event, query: string) => searchPlaces(placesHelper(), query))
  ipcMain.handle('export:settings', async (_event, id: string, settings: ExportSettings) => {
    const project = store.get(id)
    project.exportSettings = settings
    await store.save(project)
  })
  ipcMain.handle('export:preview', (_event, id: string, method: CutMethod | null) =>
    previewCuts(store, store.get(id), method)
  )
  ipcMain.handle('export:pickFolder', async (_event, current: string | null) => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose output folder',
      defaultPath: current ?? undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('export:start', (_event, request: ExportRequest) => exporter.start(request))
  ipcMain.handle('export:cancel', () => exporter.cancel())
  ipcMain.handle('export:status', () => exporter.current())
  ipcMain.handle('jobs:status', () => queue.status())
  ipcMain.handle('shell:reveal', (_event, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('app:setup', () => {
    try {
      binaries()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#14161a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  window.on('closed', () => {
    window = null
  })
}

void app.whenReady().then(async () => {
  store = new Store(join(app.getPath('userData'), 'library'))
  await store.load()
  queue = new AnalysisQueue(store, (status) => send('jobs:changed', status), publish)
  exporter = new Exporter(store, (status) => send('export:changed', status), publish)
  protocol.handle('media', handleMedia)
  registerIpc()
  createWindow()
  store.all().forEach((project) => queue.enqueue(project))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// ffmpeg would otherwise outlive the app and go on writing to its files.
let stopping = false
app.on('before-quit', (event) => {
  if (stopping) return
  event.preventDefault()
  stopping = true
  void Promise.allSettled([queue.shutdown(), exporter.shutdown()]).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
