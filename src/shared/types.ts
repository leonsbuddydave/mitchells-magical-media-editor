/** Everything the renderer needs to know about a source file, from ffprobe. */
export interface MediaInfo {
  container: string
  sizeBytes: number
  /** Container start offset. ffmpeg's -ss is relative to this. */
  startTime: number
  duration: number
  video: {
    codec: string
    profile: string | null
    pixFmt: string
    width: number
    height: number
    sar: string | null
    fps: number
    /** Exact rate as a fraction, e.g. "30000/1001". */
    fpsFraction: string
    fieldOrder: string | null
    hasBFrames: number
    colorSpace: string | null
    colorPrimaries: string | null
    colorTransfer: string | null
    colorRange: string | null
    bitRate: number | null
  }
  audio: Array<{
    index: number
    codec: string
    channels: number
    sampleRate: number
    bitRate: number | null
  }>
}

/**
 * Summary of the packet index. The full per-packet table stays in the main
 * process; the renderer only needs enough to draw and to explain cuts.
 */
export interface PacketSummary {
  frameCount: number
  keyframes: number[]
  /** Every frame is a keyframe, so any frame can be a lossless cut point. */
  intraOnly: boolean
  /** Keyframes copied video can resume from after re-encoded frames. */
  spliceableKeyframes: number
}

export type AnalysisStep = 'index' | 'proxy' | 'filmstrip'

export interface FilmstripInfo {
  /** Seconds between thumbnails. */
  interval: number
  thumbWidth: number
  thumbHeight: number
  columns: number
  rows: number
  sheets: number
  count: number
}

export interface Analysis {
  packets: PacketSummary | null
  /** Null until known, then whether playback goes through a generated proxy. */
  needsProxy: boolean | null
  proxyReady: boolean
  filmstrip: FilmstripInfo | null
  /** First frame's time after the file's start. Maps the timeline onto the file. */
  firstFrameOffset?: number
  /** Likely cuts between recordings, in timeline seconds. */
  scenes: number[]
  error: string | null
}

export interface ExportRecord {
  path: string
  at: string
  method: CutMethod
  frames: number
  reencodedFrames: number
}

/** A real-world place, confirmed by the user, with what Maps knows about it. */
export interface Place {
  name: string
  address: string
  latitude: number
  longitude: number
  /** IANA name, e.g. America/Chicago. */
  timeZone: string | null
}

export interface Clip {
  id: string
  /** Timeline seconds, measured from the first displayed frame of the rip. */
  start: number
  end: number
  title: string
  /** Free-form precision: YYYY, YYYY-MM or YYYY-MM-DD. */
  date: string
  /** HH:MM on the clip's date, or empty. */
  time: string
  /** IANA name, or empty. */
  timeZone: string
  people: string[]
  /** What the user typed: this goes in filenames. */
  location: string
  /** Where that is, once confirmed. */
  place: Place | null
  tags: string[]
  notes: string
  exports: ExportRecord[]
}

export type CutMethod = 'copy' | 'smart' | 'encode'

export type EncodePreset = 'ffv1' | 'prores' | 'h264' | 'hevc'

export type Container = 'mkv' | 'mp4' | 'mov' | 'avi' | 'mpg'

export interface ExportSettings {
  outputDir: string | null
  container: Container | null
  method: CutMethod | null
  encodePreset: EncodePreset
  template: string
}

export interface Project {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  sourcePath: string
  sourceMissing: boolean
  media: MediaInfo
  analysis: Analysis
  clips: Clip[]
  exportSettings: ExportSettings
}

export interface ProjectSummary {
  id: string
  name: string
  sourcePath: string
  sourceMissing: boolean
  duration: number
  clipCount: number
  exportedCount: number
  ready: boolean
  updatedAt: string
}

export interface JobStatus {
  projectId: string
  step: AnalysisStep
  /** 0..1, or null while the step gives no progress signal. */
  progress: number | null
  queued: AnalysisStep[]
}

/** Exactly what will happen to one clip. Pure description, nothing has run. */
export interface CutPreview {
  method: CutMethod
  /** Output start and end in timeline seconds, after any keyframe snapping. */
  start: number
  end: number
  frames: number
  reencodedFrames: number
  /** True when the output contains exactly the marked frames. */
  frameExact: boolean
  /** Extra frames kept before the marked start (stream copy on long-GOP). */
  extraFramesBefore: number
  extraFramesAfter: number
}

export interface ExportRequest {
  projectId: string
  clipIds: string[]
  settings: ExportSettings
}

export type ExportClipState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ExportClipProgress {
  clipId: string
  name: string
  state: ExportClipState
  progress: number
  outputPath: string | null
  error: string | null
  warning: string | null
}

export interface ExportStatus {
  projectId: string
  running: boolean
  clips: ExportClipProgress[]
}

export interface KnownPlace {
  label: string
  place: Place
}

export interface Suggestions {
  people: string[]
  locations: string[]
  tags: string[]
  /** Place names already confirmed, which need no lookup or confirmation again. */
  places: KnownPlace[]
}
