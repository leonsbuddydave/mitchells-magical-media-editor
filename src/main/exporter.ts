import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { renderFilename, uniqueName } from '../shared/filename'
import { defaultContainer, methodsFor } from '../shared/formats'
import type {
  Clip,
  Container,
  CutMethod,
  CutPreview,
  ExportClipProgress,
  ExportRequest,
  ExportStatus,
  Project
} from '../shared/types'
import { packetsPath } from './analysis'
import { cutClip } from './cutter'
import { frameAt, planCopy, planEncode, planSmart, type CutPlan } from './cutplan'
import { CancelledError, CancelToken } from './ffmpeg'
import { clipMetadata } from './metadata'
import { loadPacketTable, type PacketTable } from './probe'
import type { Store } from './store'

export function resolveMethod(project: Project, method: CutMethod | null): CutMethod {
  const options = methodsFor(project.media, project.analysis.packets)
  if (method && options.some((option) => option.method === method)) return method
  return options.find((option) => option.recommended)!.method
}

function planFor(table: PacketTable, clip: Clip, method: CutMethod): CutPlan {
  const first = frameAt(table, clip.start)
  const last = Math.max(first + 1, frameAt(table, clip.end))
  if (method === 'copy') return planCopy(table, first, last)
  if (method === 'smart') return planSmart(table, first, last)
  return planEncode(first, last)
}

function describePlan(table: PacketTable, plan: CutPlan, method: CutMethod): CutPreview {
  const order = table.displayOrder
  const lastEdge = plan.last < order.length ? order[plan.last] : order[order.length - 1]
  return {
    method,
    start: order[plan.first] - order[0],
    end: lastEdge - order[0],
    frames: plan.frames,
    reencodedFrames: plan.reencodedFrames,
    frameExact: plan.first === plan.wantedFirst && plan.last === plan.wantedLast,
    extraFramesBefore: Math.max(0, plan.wantedFirst - plan.first),
    extraFramesAfter: Math.max(0, plan.last - plan.wantedLast)
  }
}

export async function previewCuts(
  store: Store,
  project: Project,
  method: CutMethod | null
): Promise<Record<string, CutPreview>> {
  if (!project.analysis.packets) return {}
  const table = await loadPacketTable(packetsPath(store, project.id))
  const resolved = resolveMethod(project, method)
  return Object.fromEntries(
    project.clips.map((clip) => [clip.id, describePlan(table, planFor(table, clip, resolved), resolved)])
  )
}

/** Exports one batch at a time. Everything runs from the project on disk. */
export class Exporter {
  private status: ExportStatus | null = null
  private token: CancelToken | null = null
  private running: Promise<void> | null = null
  private lastSent = 0

  constructor(
    private readonly store: Store,
    private readonly onStatus: (status: ExportStatus) => void,
    private readonly onProject: (project: Project) => void
  ) {}

  current(): ExportStatus | null {
    return this.status
  }

  cancel(): void {
    this.token?.cancel()
  }

  /** Stops the batch and waits, so its temporary files are gone before quitting. */
  async shutdown(): Promise<void> {
    this.cancel()
    await this.running
  }

  private send(force = false): void {
    const now = Date.now()
    if (!this.status || (!force && now - this.lastSent < 200)) return
    this.lastSent = now
    this.onStatus(structuredClone(this.status))
  }

  start(request: ExportRequest): Promise<void> {
    if (this.running) return Promise.reject(new Error('An export is already running.'))
    this.running = this.run(request).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(request: ExportRequest): Promise<void> {
    const project = this.store.get(request.projectId)
    const { settings } = request
    if (!settings.outputDir) throw new Error('Choose an output folder first.')
    if (project.sourceMissing) throw new Error('The source file for this project cannot be found.')

    project.exportSettings = settings
    await this.store.save(project)

    const table = await loadPacketTable(packetsPath(this.store, project.id))
    const method = resolveMethod(project, settings.method)
    const preset = method === 'encode' ? settings.encodePreset : null
    const container: Container = settings.container ?? defaultContainer(project.media, method, settings.encodePreset)
    const ordered = [...project.clips].sort((a, b) => a.start - b.start)
    const chosen = ordered.filter((clip) => request.clipIds.includes(clip.id))

    const outputDir = settings.outputDir
    const reserved = new Set<string>()
    const taken = (name: string): boolean => reserved.has(name) || existsSync(join(outputDir, name))
    const names = new Map<string, string>()
    const entries: ExportClipProgress[] = chosen.map((clip) => {
      const base = renderFilename(settings.template, clip, {
        projectName: project.name,
        index: ordered.indexOf(clip) + 1
      })
      const name = uniqueName(base, container, taken)
      reserved.add(name)
      names.set(clip.id, name)
      return { clipId: clip.id, name, state: 'pending', progress: 0, outputPath: null, error: null, warning: null }
    })

    this.status = { projectId: project.id, running: true, clips: entries }
    const token = new CancelToken()
    this.token = token
    this.send(true)

    for (const [index, clip] of chosen.entries()) {
      const entry = entries[index]
      if (token.cancelled) {
        entry.state = 'cancelled'
        continue
      }
      entry.state = 'running'
      this.send(true)
      const outputPath = join(outputDir, names.get(clip.id)!)
      try {
        const plan = planFor(table, clip, method)
        const metadata = clipMetadata(clip, project.name, container)
        const result = await cutClip({
          sourcePath: project.sourcePath,
          media: project.media,
          table,
          plan,
          container,
          encodePreset: preset,
          metadata: metadata.ffmpeg,
          appleTags: metadata.apple,
          fileDate: metadata.fileDate,
          outputPath,
          token,
          onProgress: (fraction) => {
            entry.progress = fraction
            this.send()
          }
        })
        entry.state = 'done'
        entry.progress = 1
        entry.outputPath = outputPath
        entry.warning = result.warning
        clip.exports.push({
          path: outputPath,
          at: new Date().toISOString(),
          method,
          frames: result.frames,
          reencodedFrames: plan.reencodedFrames
        })
        await this.store.save(project)
        this.onProject(project)
      } catch (error) {
        if (error instanceof CancelledError) entry.state = 'cancelled'
        else {
          entry.state = 'failed'
          entry.error = error instanceof Error ? error.message : String(error)
        }
      }
      this.send(true)
    }
    this.status.running = false
    this.token = null
    this.send(true)
  }
}
