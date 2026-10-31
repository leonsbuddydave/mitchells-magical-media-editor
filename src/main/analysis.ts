import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AnalysisStep, FilmstripInfo, JobStatus, MediaInfo, Project } from '../shared/types'
import { CancelledError, CancelToken, ffmpeg } from './ffmpeg'
import { markIdrFrames, savePacketTable, scanPackets, summarize } from './probe'
import type { Store } from './store'

const THUMB_HEIGHT = 72
const SHEET_COLUMNS = 10
const SHEET_ROWS = 10
/** Enough thumbnails to fill a zoomed-out timeline several times over. */
const MAX_THUMBS = 1500
const SCENE_THRESHOLD = 0.35
const MIN_SCENE_GAP_SECONDS = 2
const PROXY_MAX_HEIGHT = 576

const PLAYABLE_VIDEO = /^(h264)$/
const PLAYABLE_AUDIO = /^(aac|mp3)$/

export function displayAspect(media: MediaInfo): number {
  const [x, y] = (media.video.sar ?? '1:1').split(':').map(Number)
  const sar = x > 0 && y > 0 ? x / y : 1
  return (media.video.width * sar) / media.video.height
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/**
 * Chromium plays little of what capture hardware writes, and combs interlaced
 * footage. Anything else plays through a generated proxy, which keeps every
 * frame so that a time on the timeline always means the same frame in the rip.
 */
export function needsProxy(media: MediaInfo, firstFrameOffset: number): boolean {
  const { video, audio } = media
  const direct =
    /mp4|mov/.test(media.container) &&
    PLAYABLE_VIDEO.test(video.codec) &&
    video.pixFmt === 'yuv420p' &&
    video.fieldOrder === 'progressive' &&
    audio.every((stream) => PLAYABLE_AUDIO.test(stream.codec)) &&
    Math.abs(media.startTime) < 0.001 &&
    Math.abs(firstFrameOffset) < 0.001
  return !direct
}

/**
 * Clears what an earlier run left next to `path`. Each run writes to its own
 * temporary name, because a crashed app's ffmpeg can still be running, and two
 * writers on one file produce a preview that looks complete but is damaged.
 */
async function clearStale(path: string): Promise<void> {
  const directory = dirname(path)
  const prefix = `${basename(path)}.tmp-`
  const names = await readdir(directory)
  await Promise.all(
    names.filter((name) => name.startsWith(prefix)).map((name) => rm(join(directory, name), { recursive: true, force: true }))
  )
}

function temporaryName(path: string): string {
  return `${path}.tmp-${randomUUID()}`
}

export function proxyPath(store: Store, id: string): string {
  return join(store.dir(id), 'proxy.mp4')
}

export function packetsPath(store: Store, id: string): string {
  return join(store.dir(id), 'packets.bin')
}

export function filmstripDir(store: Store, id: string): string {
  return join(store.dir(id), 'filmstrip')
}

function proxyVideoFilter(media: MediaInfo): string {
  const scale = Math.min(1, PROXY_MAX_HEIGHT / media.video.height)
  const height = even(media.video.height * scale)
  const width = even(height * displayAspect(media))
  return [
    ...(media.video.fieldOrder === 'progressive' ? [] : ['bwdif=mode=send_frame:deint=interlaced']),
    `scale=${width}:${height}`,
    'setsar=1',
    'setpts=PTS-STARTPTS'
  ].join(',')
}

export function proxyEncoders(): string[][] {
  const software = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-bf', '0']
  if (process.platform !== 'darwin') return [software]
  return [['-c:v', 'h264_videotoolbox', '-b:v', '2M', '-bf', '0', '-allow_sw', '1'], software]
}

export async function buildProxy(
  sourcePath: string,
  media: MediaInfo,
  firstFrameOffset: number,
  output: string,
  options: { token?: CancelToken; onProgress?: (seconds: number) => void } = {}
): Promise<void> {
  await clearStale(output)
  const partial = temporaryName(output)
  // The proxy's clock must start on the rip's first frame. Audio is padded to the
  // file's own start, then trimmed by however much the first frame comes after it.
  const audioFilter = `aresample=async=1:first_pts=0,atrim=start=${firstFrameOffset.toFixed(6)},asetpts=PTS-STARTPTS`
  const hasAudio = media.audio.length > 0
  let failure: unknown
  for (const encoder of proxyEncoders()) {
    try {
      await ffmpeg(
        [
          '-fflags', '+genpts', '-i', sourcePath,
          '-map', '0:v:0',
          ...(hasAudio ? ['-map', '0:a:0', '-af', audioFilter, '-c:a', 'aac', '-b:a', '160k', '-ac', '2'] : []),
          '-vf', proxyVideoFilter(media),
          '-fps_mode', 'passthrough',
          ...encoder,
          '-g', '12', '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart', '-f', 'mp4', '-y', partial
        ],
        options
      )
      await rename(partial, output)
      return
    } catch (error) {
      await rm(partial, { force: true })
      if (error instanceof CancelledError) throw error
      failure = error
    }
  }
  throw failure
}

/** Thumbnails and likely recording boundaries, from one pass over the video. */
export async function buildFilmstrip(
  input: string,
  media: MediaInfo,
  output: string,
  options: { token?: CancelToken; onProgress?: (seconds: number) => void } = {}
): Promise<{ filmstrip: FilmstripInfo; scenes: number[] }> {
  await mkdir(dirname(output), { recursive: true })
  await clearStale(output)
  const partial = temporaryName(output)
  await mkdir(partial)
  const interval = Math.max(1, media.duration / MAX_THUMBS)
  const thumbWidth = even(THUMB_HEIGHT * displayAspect(media))
  const graph =
    `[0:v:0]split=2[strip][detect];` +
    `[strip]fps=1/${interval.toFixed(4)},scale=${thumbWidth}:${THUMB_HEIGHT},tile=${SHEET_COLUMNS}x${SHEET_ROWS}[sheets];` +
    // Printing every frame's score doubles as progress, which ffmpeg can't report
    // here: its position only moves when a whole sheet of thumbnails is finished.
    `[detect]scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-[scores]`
  const scenes: number[] = []
  let frameTime = 0
  try {
    await ffmpeg(
      [
        '-i', input,
        '-filter_complex', graph,
        '-map', '[sheets]', '-q:v', '5', join(partial, 'sheet-%04d.jpg'),
        '-map', '[scores]', '-f', 'null', '-'
      ],
      {
        token: options.token,
        onLine: (line) => {
          const time = /pts_time:([\d.]+)/.exec(line)
          if (time) {
            frameTime = Number(time[1])
            options.onProgress?.(frameTime)
            return
          }
          const score = /^lavfi\.scene_score=([\d.]+)/.exec(line)
          if (!score || Number(score[1]) <= SCENE_THRESHOLD) return
          if (scenes.length === 0 || frameTime - scenes[scenes.length - 1] >= MIN_SCENE_GAP_SECONDS) scenes.push(frameTime)
        }
      }
    )
    await rm(output, { recursive: true, force: true })
    await rename(partial, output)
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    throw error
  }
  const sheets = (await readdir(output)).filter((name) => name.endsWith('.jpg')).length
  return {
    scenes,
    filmstrip: {
      interval,
      thumbWidth,
      thumbHeight: THUMB_HEIGHT,
      columns: SHEET_COLUMNS,
      rows: SHEET_ROWS,
      sheets,
      count: Math.ceil(media.duration / interval)
    }
  }
}

interface Queued {
  projectId: string
  step: AnalysisStep
}

/** Runs generation work one step at a time, with the open project first. */
export class AnalysisQueue {
  private queue: Queued[] = []
  private active: { job: Queued; token: CancelToken; finished: Promise<void> } | null = null
  private progress: number | null = null
  private stopped = false

  constructor(
    private readonly store: Store,
    private readonly onStatus: (status: JobStatus[]) => void,
    private readonly onProject: (project: Project) => void
  ) {}

  enqueue(project: Project): void {
    if (project.sourceMissing) return
    const { analysis, id } = project
    const steps: AnalysisStep[] = []
    if (!analysis.packets) steps.push('index')
    if (analysis.needsProxy !== false && !analysis.proxyReady) steps.push('proxy')
    if (!analysis.filmstrip) steps.push('filmstrip')
    for (const step of steps) {
      const alreadyActive = this.active?.job.projectId === id && this.active.job.step === step
      const alreadyQueued = this.queue.some((job) => job.projectId === id && job.step === step)
      if (!alreadyActive && !alreadyQueued) this.queue.push({ projectId: id, step })
    }
    this.pump()
  }

  prioritize(id: string): void {
    const mine = this.queue.filter((job) => job.projectId === id)
    this.queue = [...mine, ...this.queue.filter((job) => job.projectId !== id)]
    this.report()
  }

  cancel(id: string): void {
    this.queue = this.queue.filter((job) => job.projectId !== id)
    if (this.active?.job.projectId === id) this.active.token.cancel()
    this.report()
  }

  status(): JobStatus[] {
    const byProject = new Map<string, JobStatus>()
    if (this.active) {
      const { projectId, step } = this.active.job
      byProject.set(projectId, { projectId, step, progress: this.progress, queued: [] })
    }
    for (const { projectId, step } of this.queue) {
      const existing = byProject.get(projectId)
      if (existing) existing.queued.push(step)
      else byProject.set(projectId, { projectId, step, progress: null, queued: [step] })
    }
    return [...byProject.values()]
  }

  private report(): void {
    this.onStatus(this.status())
  }

  /** Stops the running step and waits for its ffmpeg to be gone. Restart redoes it. */
  async shutdown(): Promise<void> {
    this.stopped = true
    this.queue = []
    this.active?.token.cancel()
    await this.active?.finished
  }

  private pump(): void {
    if (this.active || this.stopped) return
    const job = this.queue.shift()
    if (!job) {
      this.report()
      return
    }
    const token = new CancelToken()
    this.progress = null
    const finished = this.run(job, token).finally(() => {
      this.active = null
      this.pump()
    })
    this.active = { job, token, finished }
    this.report()
  }

  private async run(job: Queued, token: CancelToken): Promise<void> {
    if (!this.store.has(job.projectId)) return
    const project = this.store.get(job.projectId)
    let lastReport = 0
    const onProgress = (seconds: number): void => {
      if (project.media.duration > 0) this.progress = Math.min(seconds / project.media.duration, 1)
      const now = Date.now()
      if (now - lastReport > 250) {
        lastReport = now
        this.report()
      }
    }
    try {
      await this.perform(job.step, project, token, onProgress)
      project.analysis.error = null
    } catch (error) {
      if (error instanceof CancelledError) return
      project.analysis.error = error instanceof Error ? error.message : String(error)
      this.queue = this.queue.filter((queued) => queued.projectId !== project.id)
    }
    if (!this.store.has(project.id)) return
    await this.store.save(project)
    this.onProject(project)
  }

  private async perform(
    step: AnalysisStep,
    project: Project,
    token: CancelToken,
    onProgress: (seconds: number) => void
  ): Promise<void> {
    const { store } = this
    const { id, media, sourcePath, analysis } = project
    switch (step) {
      case 'index': {
        const table = await scanPackets(sourcePath, { token, onProgress })
        if (media.video.codec === 'h264') await markIdrFrames(sourcePath, table, token)
        await savePacketTable(packetsPath(store, id), table)
        analysis.packets = summarize(table)
        analysis.firstFrameOffset = table.displayOrder[0] - media.startTime
        analysis.needsProxy = needsProxy(media, analysis.firstFrameOffset)
        if (!analysis.needsProxy) this.queue = this.queue.filter((job) => !(job.projectId === id && job.step === 'proxy'))
        return
      }
      case 'proxy':
        await buildProxy(sourcePath, media, analysis.firstFrameOffset ?? 0, proxyPath(store, id), { token, onProgress })
        analysis.proxyReady = true
        return
      case 'filmstrip': {
        const input = analysis.needsProxy ? proxyPath(store, id) : sourcePath
        const result = await buildFilmstrip(input, media, filmstripDir(store, id), { token, onProgress })
        analysis.filmstrip = result.filmstrip
        analysis.scenes = result.scenes
      }
    }
  }
}
