import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Container, EncodePreset, MediaInfo } from '../shared/types'
import { AUDIO_FALLBACK, ENCODE_PRESETS, supportsAudio, supportsVideo } from '../shared/formats'
import { CancelledError, exiftool, exiftoolPath, ffmpeg, ffprobe, type CancelToken } from './ffmpeg'
import type { CutPlan, CopySegment, EncodeSegment } from './cutplan'
import { frameCount, lowerBound } from './cutplan'
import type { PacketTable } from './probe'

export interface CutRequest {
  sourcePath: string
  media: MediaInfo
  table: PacketTable
  plan: CutPlan
  container: Container
  /** Set when the whole clip is converted rather than cut. */
  encodePreset: EncodePreset | null
  metadata: string[]
  /** exiftool arguments, for tags ffmpeg can't write. */
  appleTags?: string[]
  /** Sets the file's own dates, which Finder and Spotlight go by. */
  fileDate?: Date | null
  outputPath: string
  token?: CancelToken
  onProgress?: (fraction: number) => void
}

export interface CutResult {
  frames: number
  warning: string | null
}

/** Enough read-ahead that seeking lands before the packet we actually want. */
const SEEK_PREROLL_SECONDS = 15

/** Trimming starts just before the frame, so rounding cannot skip past it. */
const TRIM_BIAS = 0.001

/** Keeps reading a little past the last packet, which is picked out exactly. */
const INPUT_TAIL_SECONDS = 2

const MUXER: Record<Container, string> = {
  mkv: 'matroska',
  mp4: 'mp4',
  mov: 'mov',
  avi: 'avi',
  // The plain mpeg muxer writes MPEG-1 system streams.
  mpg: 'vob'
}

function frameSeconds(media: MediaInfo): number {
  return media.video.fps > 0 ? 1 / media.video.fps : 0.04
}

/**
 * All runs use -copyts, so packets and frames keep the file's own timestamps, the
 * clock of the packet table. Otherwise ffmpeg rebases them on the seek point, and
 * where that lands depends on the container. -ss is only ever a hint to get near.
 */
function seekHint(request: CutRequest, fileTime: number): number {
  return Math.max(0, fileTime - request.media.startTime - SEEK_PREROLL_SECONDS)
}

function fixed(value: number): string {
  return value.toFixed(6)
}

function isInterlaced(media: MediaInfo): boolean {
  const order = media.video.fieldOrder
  return order !== null && order !== 'progressive'
}

function topFieldFirst(media: MediaInfo): boolean {
  return media.video.fieldOrder === 'tt' || media.video.fieldOrder === 'tb'
}

function colorArgs(media: MediaInfo): string[] {
  const { colorSpace, colorPrimaries, colorTransfer, colorRange } = media.video
  return [
    ...(colorSpace ? ['-colorspace', colorSpace] : []),
    ...(colorPrimaries ? ['-color_primaries', colorPrimaries] : []),
    ...(colorTransfer ? ['-color_trc', colorTransfer] : []),
    ...(colorRange ? ['-color_range', colorRange] : [])
  ]
}

const X264_PROFILES: Record<string, string> = {
  'Constrained Baseline': 'baseline',
  Baseline: 'baseline',
  Main: 'main',
  High: 'high',
  'High 10': 'high10',
  'High 4:2:2': 'high422',
  'High 4:4:4 Predictive': 'high444'
}

/** Encoder settings for the frames spliced in next to copied video. */
function spliceEncoderArgs(media: MediaInfo): string[] {
  const { codec, profile, pixFmt, hasBFrames } = media.video
  const interlaced = isInterlaced(media)
  const common = ['-pix_fmt', pixFmt, ...colorArgs(media)]
  switch (codec) {
    case 'h264': {
      const x264Profile = profile ? X264_PROFILES[profile] : undefined
      return [
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '14',
        '-bf', String(Math.min(hasBFrames > 0 ? 3 : 0, 3)),
        ...(x264Profile ? ['-profile:v', x264Profile] : []),
        ...(interlaced
          ? ['-flags', '+ildct+ilme', '-x264opts', `${topFieldFirst(media) ? 'tff' : 'bff'}=1`]
          : []),
        ...common
      ]
    }
    case 'hevc':
      return [
        '-c:v', 'libx265', '-preset', 'medium', '-crf', '12',
        '-x265-params', 'log-level=error:repeat-headers=1',
        ...common
      ]
    case 'mpeg2video':
      return [
        '-c:v', 'mpeg2video', '-q:v', '2', '-qmin', '1', '-bf', '2', '-sc_threshold', '1000000000',
        '-fps_mode', 'cfr', '-r', media.video.fpsFraction,
        '-flags', `+cgop${interlaced ? '+ildct+ilme' : ''}`,
        ...(interlaced ? ['-top', topFieldFirst(media) ? '1' : '0'] : []),
        ...common
      ]
    default:
      throw new Error(`Smart cut does not support ${codec}.`)
  }
}

function presetEncoderArgs(media: MediaInfo, preset: EncodePreset): string[] {
  const interlaced = isInterlaced(media)
  const color = colorArgs(media)
  switch (preset) {
    case 'ffv1':
      return ['-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '16', '-slicecrc', '1', ...color]
    case 'prores':
      return [
        '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le',
        ...(interlaced ? ['-flags', '+ildct'] : []),
        ...color
      ]
    case 'h264':
      return [
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
        ...(interlaced
          ? ['-flags', '+ildct+ilme', '-x264opts', `${topFieldFirst(media) ? 'tff' : 'bff'}=1`]
          : []),
        ...color
      ]
    case 'hevc':
      return [
        '-c:v', 'libx265', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-x265-params', 'log-level=error',
        ...color
      ]
  }
}

/** Moves a packet range to start at zero, filling in whichever timestamp is missing. */
function zeroed(from: string): string {
  return `setts=pts='if(isnan(PTS),DTS,PTS)-${from}/TB':dts='if(isnan(DTS),PTS,DTS)-${from}/TB'`
}

function audioCodec(stream: MediaInfo['audio'][number], container: Container): string {
  return supportsAudio(container, stream.codec) ? 'copy' : AUDIO_FALLBACK[container].codec
}

/**
 * Audio for the frame range. Like video, audio cannot use -ss in a stream copy:
 * ffmpeg seeks to a video keyframe even when only audio is mapped, then re-zeroes
 * the output, which would silently slip the soundtrack against the picture. So
 * copied streams are picked by packet time and transcoded ones by atrim.
 */
function audioWindow(request: CutRequest, firstFrame: number, seconds: number): { input: string[]; output: string[] } {
  const { media, container, sourcePath, table } = request
  if (media.audio.length === 0) return { input: [], output: [] }
  const start = table.displayOrder[firstFrame]
  const preroll = seekHint(request, start)
  const from = fixed(start)
  const to = fixed(start + seconds)
  const packetTime = 'if(isnan(pts),dts,pts)*tb'
  const output = media.audio.flatMap((stream, index) => {
    const codec = audioCodec(stream, container)
    if (codec === 'copy') {
      return [
        `-c:a:${index}`, 'copy',
        `-bsf:a:${index}`,
        `noise=drop='lt(${packetTime},${from})+gte(${packetTime},${to})',${zeroed(from)}`
      ]
    }
    return [
      `-c:a:${index}`, codec,
      ...(codec === 'mp2' ? [`-b:a:${index}`, '384k'] : []),
      `-filter:a:${index}`, `atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS`
    ]
  })
  return {
    input: [
      ...(preroll > 0 ? ['-ss', fixed(preroll)] : []),
      '-t', fixed(start - media.startTime - preroll + seconds + INPUT_TAIL_SECONDS),
      '-i', sourcePath
    ],
    output
  }
}

function containerArgs(request: CutRequest, videoCodec: string): string[] {
  const appleFamily = request.container === 'mp4' || request.container === 'mov'
  return [
    ...(appleFamily ? ['-movflags', '+faststart'] : []),
    ...(appleFamily && videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    ...request.metadata,
    '-f', MUXER[request.container]
  ]
}

function outputSeconds(request: CutRequest): number {
  const { table, plan } = request
  const order = table.displayOrder
  const lastTime = plan.last < order.length ? order[plan.last] : order[order.length - 1] + frameSeconds(request.media)
  return lastTime - order[plan.first]
}

/**
 * Bitstream filters that put parameter sets in front of every keyframe. A
 * spliced body may not start on an IDR frame, and without them it would be
 * decoded with the headers of the re-encoded segment before it.
 */
function inBandHeaders(codec: string): string {
  if (codec === 'h264') return 'h264_mp4toannexb,dump_extra=freq=keyframe,'
  if (codec === 'hevc') return 'hevc_mp4toannexb,dump_extra=freq=keyframe,'
  return ''
}

/**
 * Reads exactly the packets of a copy segment. Time-based stream copying can
 * land on the wrong keyframe, so the packets are chosen by the noise filter's
 * drop expression and re-zeroed by setts, working from the packet table.
 */
function copyInputArgs(
  request: CutRequest,
  segment: CopySegment,
  headers = ''
): { input: string[]; bitstream: string[] } {
  const { table, media, sourcePath } = request
  const halfFrame = frameSeconds(media) / 2
  const entry = table.pts[segment.fromPacket]
  const preroll = seekHint(request, entry)

  let stop = Number.POSITIVE_INFINITY
  if (segment.toPacket < table.pts.length) {
    const next = table.dts[segment.toPacket]
    stop = Number.isFinite(next) ? next : table.pts[segment.toPacket]
  }
  const packetTime = 'if(isnan(pts),dts,pts)*tb'
  const before = `lt(${packetTime},${fixed(entry - halfFrame)})`
  const after = Number.isFinite(stop) ? `+gte(dts*tb,${fixed(stop - halfFrame)})` : ''
  return {
    input: [
      '-fflags', '+genpts',
      ...(preroll > 0 ? ['-ss', fixed(preroll)] : []),
      ...(Number.isFinite(stop) ? ['-t', fixed(stop - media.startTime - preroll + INPUT_TAIL_SECONDS)] : []),
      '-i', sourcePath
    ],
    bitstream: ['-bsf:v', `${headers}noise=drop='${before}${after}',${zeroed(fixed(entry))}`]
  }
}

/**
 * Input and filter that deliver decoded frames starting exactly at `frame`.
 * Even a decoding -ss overshoots on files without a seek index, such as MPEG
 * program streams, so this seeks well ahead of the frame and trims by time.
 */
function decodeFrom(request: CutRequest, frame: number): { input: string[]; filter: string } {
  const time = request.table.displayOrder[frame]
  const preroll = seekHint(request, time)
  return {
    input: [
      '-fflags', '+genpts',
      ...(preroll > 0 ? ['-noaccurate_seek', '-ss', fixed(preroll)] : []),
      '-i', request.sourcePath
    ],
    filter: `trim=start=${fixed(time - TRIM_BIAS)},setpts=PTS-STARTPTS`
  }
}

async function encodeSegmentToTs(
  request: CutRequest,
  segment: EncodeSegment,
  output: string,
  onSeconds: (seconds: number) => void
): Promise<void> {
  const { input, filter } = decodeFrom(request, segment.first)
  await ffmpeg(
    [
      '-copyts',
      ...input,
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', filter,
      '-frames:v', String(frameCount(segment)),
      '-fps_mode', 'passthrough',
      ...spliceEncoderArgs(request.media),
      '-f', 'mpegts', '-y', output
    ],
    { token: request.token, onProgress: onSeconds }
  )
}

async function copySegmentToTs(
  request: CutRequest,
  segment: CopySegment,
  output: string,
  onSeconds: (seconds: number) => void
): Promise<void> {
  const { input, bitstream } = copyInputArgs(request, segment, inBandHeaders(request.media.video.codec))
  await ffmpeg(
    ['-copyts', ...input, '-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'copy', ...bitstream, '-f', 'mpegts', '-y', output],
    { token: request.token, onProgress: onSeconds }
  )
}

function segmentSeconds(request: CutRequest, first: number, last: number): number {
  const order = request.table.displayOrder
  return (last < order.length ? order[last] : order[order.length - 1] + frameSeconds(request.media)) - order[first]
}

/** Encoders we splice with never hold back more frames than this. */
const SPLICE_ENCODER_DELAY = 3

/**
 * Decode timestamps for spliced video. Each segment has its own reordering
 * delay, so at a join the DTS could run backwards, which muxers reject. Display
 * timing lives in PTS, so DTS is regenerated from packet order instead, starting
 * early enough to stay at or before every PTS in the clip.
 */
function regenerateDts(request: CutRequest): string {
  const { table, plan, media } = request
  const order = table.displayOrder
  const frame = frameSeconds(media)
  let delay = SPLICE_ENCODER_DELAY
  for (const segment of plan.segments) {
    if (segment.kind !== 'copy') continue
    for (let packet = segment.fromPacket; packet < segment.toPacket; packet += 1) {
      const shown = lowerBound(order, table.pts[packet]) - segment.first
      delay = Math.max(delay, packet - segment.fromPacket - shown)
    }
  }
  // Variable frame rate puts frames ahead of a constant-rate grid.
  let drift = 0
  for (let i = plan.first; i < plan.last; i += 1) {
    drift = Math.max(drift, (i - plan.first) * frame - (order[i] - order[plan.first]))
  }
  delay += Math.ceil(drift / frame)
  return `setts=pts=PTS:dts=(N-${delay})*${fixed(frame)}/TB`
}

function concatLine(path: string): string {
  return `file '${path.replaceAll("'", "'\\''")}'`
}

/** Multi-segment output: splices re-encoded edges around a copied middle. */
async function runSpliced(request: CutRequest, partPath: string, workDir: string): Promise<void> {
  const { plan, token, onProgress } = request
  const totalSeconds = outputSeconds(request)
  const listLines = ['ffconcat version 1.0']
  let doneSeconds = 0

  for (const [index, segment] of plan.segments.entries()) {
    const path = join(workDir, `segment-${index}.ts`)
    const seconds = segmentSeconds(request, segment.first, segment.last)
    const report = (written: number): void =>
      onProgress?.((0.85 * (doneSeconds + Math.min(written, seconds))) / totalSeconds)
    if (segment.kind === 'encode') await encodeSegmentToTs(request, segment, path, report)
    else await copySegmentToTs(request, segment, path, report)
    doneSeconds += seconds
    listLines.push(concatLine(path), `duration ${fixed(seconds)}`)
  }

  const listPath = join(workDir, 'segments.ffconcat')
  await writeFile(listPath, `${listLines.join('\n')}\n`)
  const hasAudio = request.media.audio.length > 0
  const audio = audioWindow(request, plan.first, totalSeconds)
  await ffmpeg(
    [
      '-copyts',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      ...audio.input,
      '-map', '0:v:0',
      ...(hasAudio ? ['-map', '1:a'] : []),
      '-c:v', 'copy',
      '-bsf:v', regenerateDts(request),
      ...audio.output,
      ...containerArgs(request, request.media.video.codec),
      '-y', partPath
    ],
    { token, onProgress: (written) => onProgress?.(0.85 + (0.15 * Math.min(written, totalSeconds)) / totalSeconds) }
  )
}

async function runCopy(request: CutRequest, segment: CopySegment, partPath: string): Promise<void> {
  const { input, bitstream } = copyInputArgs(request, segment)
  const seconds = outputSeconds(request)
  const hasAudio = request.media.audio.length > 0
  const audio = audioWindow(request, segment.first, seconds)
  await ffmpeg(
    [
      '-copyts',
      ...input,
      ...audio.input,
      '-map', '0:v:0',
      ...(hasAudio ? ['-map', '1:a'] : []),
      '-c:v', 'copy',
      ...bitstream,
      ...audio.output,
      ...containerArgs(request, request.media.video.codec),
      '-y', partPath
    ],
    { token: request.token, onProgress: (written) => request.onProgress?.(Math.min(written / seconds, 1)) }
  )
}

async function runEncode(request: CutRequest, preset: EncodePreset, partPath: string): Promise<void> {
  const { plan, media, token, onProgress } = request
  const seconds = outputSeconds(request)
  const { input, filter } = decodeFrom(request, plan.first)
  const audio = audioWindow(request, plan.first, seconds)
  await ffmpeg(
    [
      '-copyts',
      ...input,
      ...audio.input,
      '-map', '0:v:0',
      ...(media.audio.length > 0 ? ['-map', '1:a'] : []),
      '-vf', filter,
      '-frames:v', String(plan.frames),
      '-fps_mode', 'passthrough',
      ...presetEncoderArgs(media, preset),
      ...audio.output,
      ...containerArgs(request, ENCODE_PRESETS[preset].codec),
      '-y', partPath
    ],
    { token, onProgress: (written) => onProgress?.(Math.min(written / seconds, 1)) }
  )
}

async function countFrames(path: string): Promise<number> {
  const { stdout } = await ffprobe([
    '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path
  ])
  return Number.parseInt(stdout, 10)
}

/**
 * Decodes the finished clip, which is where a bad splice would show. A worn tape
 * can make a rip that has decode errors of its own, so this warns, not fails.
 */
async function decodeWarning(path: string, token?: CancelToken): Promise<string | null> {
  const { stderr } = await ffmpeg(['-i', path, '-map', '0:v:0', '-f', 'null', '-'], { token })
  const first = stderr.trim().split('\n')[0]
  return first ? `The decoder reported a problem, so check this clip: ${first}` : null
}

/** Edits the file in place. No video or audio data moves or changes. */
async function writeAppleTags(path: string, tags: string[], token?: CancelToken): Promise<string | null> {
  if (tags.length === 0) return null
  const binary = exiftoolPath()
  if (!binary) return 'Location and date tags for Apple apps were skipped: install them with brew install exiftool.'
  try {
    await exiftool(binary, ['-q', '-overwrite_original', ...tags, path], { token })
    return null
  } catch (error) {
    if (error instanceof CancelledError) throw error
    return `Some tags couldn't be written: ${error instanceof Error ? error.message : String(error)}`
  }
}

export async function cutClip(request: CutRequest): Promise<CutResult> {
  const { plan, outputPath, encodePreset, container, media } = request
  const codec = encodePreset ? ENCODE_PRESETS[encodePreset].codec : media.video.codec
  if (!supportsVideo(container, codec)) throw new Error(`${codec} video cannot be stored in ${container}.`)

  const outputDir = dirname(outputPath)
  await mkdir(outputDir, { recursive: true })
  const workDir = join(outputDir, `.magical-media-${randomUUID()}`)
  const partPath = join(workDir, `output.${container}`)
  await mkdir(workDir)
  try {
    const only = plan.segments[0]
    if (encodePreset) await runEncode(request, encodePreset, partPath)
    else if (plan.segments.length === 1 && only.kind === 'copy') await runCopy(request, only, partPath)
    else await runSpliced(request, partPath, workDir)

    const frames = await countFrames(partPath)
    const countWarning = frames === plan.frames ? null : `Expected ${plan.frames} frames but the file has ${frames}.`
    const spliced = plan.segments.length > 1
    const decoded = countWarning ?? (spliced ? await decodeWarning(partPath, request.token) : null)
    const tagged = await writeAppleTags(partPath, request.appleTags ?? [], request.token)
    const warning = decoded ?? tagged
    await rename(partPath, outputPath)
    if (request.fileDate) await utimes(outputPath, request.fileDate, request.fileDate)
    request.onProgress?.(1)
    return { frames, warning }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
