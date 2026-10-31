import { readFile, stat, writeFile } from 'node:fs/promises'
import type { MediaInfo, PacketSummary } from '../shared/types'
import { ffmpeg, ffprobe, type CancelToken } from './ffmpeg'

interface ProbeStream {
  index: number
  codec_type: string
  codec_name?: string
  profile?: string
  pix_fmt?: string
  width?: number
  height?: number
  sample_aspect_ratio?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  field_order?: string
  has_b_frames?: number
  color_space?: string
  color_primaries?: string
  color_transfer?: string
  color_range?: string
  bit_rate?: string
  channels?: number
  sample_rate?: string
  disposition?: { attached_pic?: number }
}

function known(value: string | undefined): string | null {
  return value && value !== 'unknown' && value !== 'N/A' ? value : null
}

function parseFraction(value: string | undefined): number {
  if (!value) return 0
  const [numerator, denominator] = value.split('/').map(Number)
  if (!denominator) return Number.isFinite(numerator) ? numerator : 0
  return numerator / denominator
}

function optionalNumber(value: string | undefined): number | null {
  const parsed = Number(value)
  return value && Number.isFinite(parsed) ? parsed : null
}

export async function probeMedia(path: string): Promise<MediaInfo> {
  const { stdout } = await ffprobe(['-show_format', '-show_streams', '-of', 'json', path])
  const data = JSON.parse(stdout) as {
    streams: ProbeStream[]
    format: {
      format_name: string
      start_time?: string
      duration?: string
      size?: string
      tags?: { major_brand?: string }
    }
  }
  const video = data.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!video || !video.codec_name) throw new Error('This file has no video stream.')

  const fpsFraction = parseFraction(video.avg_frame_rate) > 0 ? video.avg_frame_rate! : (video.r_frame_rate ?? '25/1')
  return {
    // ffprobe names MOV and MP4 alike; only the brand tells them apart.
    container: data.format.tags?.major_brand?.trim() === 'qt' ? 'mov' : data.format.format_name,
    sizeBytes: Number(data.format.size) || (await stat(path)).size,
    startTime: Number(data.format.start_time) || 0,
    duration: Number(data.format.duration) || 0,
    video: {
      codec: video.codec_name,
      profile: known(video.profile),
      pixFmt: video.pix_fmt ?? 'yuv420p',
      width: video.width ?? 0,
      height: video.height ?? 0,
      sar: known(video.sample_aspect_ratio),
      fps: parseFraction(fpsFraction),
      fpsFraction,
      fieldOrder: known(video.field_order),
      hasBFrames: video.has_b_frames ?? 0,
      colorSpace: known(video.color_space),
      colorPrimaries: known(video.color_primaries),
      colorTransfer: known(video.color_transfer),
      colorRange: known(video.color_range),
      bitRate: optionalNumber(video.bit_rate)
    },
    audio: data.streams
      .filter((s) => s.codec_type === 'audio' && s.codec_name)
      .map((s) => ({
        index: s.index,
        codec: s.codec_name!,
        channels: s.channels ?? 2,
        sampleRate: Number(s.sample_rate) || 48000,
        bitRate: optionalNumber(s.bit_rate)
      }))
  }
}

/**
 * The video packets of a file in decode order. All cut decisions are made from
 * this table rather than from ffmpeg's -ss, which can start a stream copy a
 * whole GOP away from the requested time.
 */
export interface PacketTable {
  /** Presentation time of each packet, seconds on the file's own clock. */
  pts: Float64Array
  dts: Float64Array
  key: Uint8Array
  /** All presentation times ascending: the display order of the frames. */
  displayOrder: Float64Array
  /** Set once key holds SPLICE_POINT for every keyframe a splice may start on. */
  splicePointsMarked: boolean
}

/** Value in PacketTable.key for a keyframe that can safely follow re-encoded video. */
export const SPLICE_POINT = 2

export function buildPacketTable(pts: number[], dts: number[], key: boolean[]): PacketTable {
  return {
    pts: Float64Array.from(pts),
    dts: Float64Array.from(dts),
    key: Uint8Array.from(key, (flag) => (flag ? 1 : 0)),
    displayOrder: Float64Array.from(pts).sort(),
    splicePointsMarked: false
  }
}

/**
 * A spliced-in segment brings its own H.264 headers, and those may only change at
 * an IDR frame. Open-GOP keyframes are plain I-frames, and splicing onto one makes
 * decoders silently drop frames, so the IDRs are found here. filter_units keeps
 * only IDR slices, so packets survive only if they had one, with no decoding.
 */
export async function markIdrFrames(path: string, table: PacketTable, token?: CancelToken): Promise<void> {
  const keyPackets: number[] = []
  for (let i = 0; i < table.key.length; i += 1) if (table.key[i]) keyPackets.push(i)
  keyPackets.sort((a, b) => table.pts[a] - table.pts[b])

  let timeBase = 0
  await ffmpeg(
    [
      '-copyts', '-fflags', '+genpts', '-i', path, '-map', '0:v:0', '-c', 'copy',
      '-bsf:v', "noise=drop='not(key)',filter_units=pass_types=5", '-f', 'framecrc', '-'
    ],
    {
      token,
      onLine: (line) => {
        const header = /^#tb 0: (\d+)\/(\d+)/.exec(line)
        if (header) timeBase = Number(header[1]) / Number(header[2])
        if (line.startsWith('#')) return
        const fields = line.split(',')
        if (fields.length < 6) return
        const time = Number(fields[2]) * timeBase
        let low = 0
        let high = keyPackets.length - 1
        while (low < high) {
          const middle = (low + high) >>> 1
          if (table.pts[keyPackets[middle]] < time) low = middle + 1
          else high = middle
        }
        const nearest = [keyPackets[low], keyPackets[low - 1]].filter((packet) => packet !== undefined)
        const match = nearest.sort((a, b) => Math.abs(table.pts[a] - time) - Math.abs(table.pts[b] - time))[0]
        if (match !== undefined) table.key[match] = SPLICE_POINT
      }
    }
  )
  table.splicePointsMarked = true
}

export async function scanPackets(
  path: string,
  options: { token?: CancelToken; onProgress?: (seconds: number) => void } = {}
): Promise<PacketTable> {
  const pts: number[] = []
  const dts: number[] = []
  const key: boolean[] = []
  await ffprobe(
    // MPEG program streams can leave a packet's pts unset, keyframes included.
    ['-fflags', '+genpts', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', path],
    {
      token: options.token,
      onLine: (line) => {
        const [ptsText, dtsText, flags] = line.split(',')
        if (flags === undefined) return
        const dtsValue = Number(dtsText)
        const ptsValue = Number(ptsText)
        const hasDts = Number.isFinite(dtsValue) && dtsText !== ''
        const hasPts = Number.isFinite(ptsValue) && ptsText !== ''
        // AVI gives no pts and Matroska no dts on its first few packets.
        if (!hasPts && !hasDts) return
        pts.push(hasPts ? ptsValue : dtsValue)
        dts.push(hasDts ? dtsValue : Number.NEGATIVE_INFINITY)
        key.push(flags.includes('K'))
        if (pts.length % 5000 === 0) options.onProgress?.(pts[pts.length - 1])
      }
    }
  )
  if (pts.length === 0) throw new Error('No video packets could be read from this file.')
  return buildPacketTable(pts, dts, key)
}

export function summarize(table: PacketTable): PacketSummary {
  const first = table.displayOrder[0]
  const keyframes: number[] = []
  for (let i = 0; i < table.pts.length; i += 1) {
    if (table.key[i]) keyframes.push(table.pts[i] - first)
  }
  keyframes.sort((a, b) => a - b)
  return {
    frameCount: table.pts.length,
    keyframes,
    intraOnly: keyframes.length === table.pts.length,
    spliceableKeyframes: table.splicePointsMarked
      ? table.key.reduce((count, value) => count + (value === SPLICE_POINT ? 1 : 0), 0)
      : keyframes.length
  }
}

export async function savePacketTable(path: string, table: PacketTable): Promise<void> {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(table.pts.length, 0)
  header.writeUInt32LE(table.splicePointsMarked ? 1 : 0, 4)
  await writeFile(
    path,
    Buffer.concat([
      header,
      Buffer.from(table.pts.buffer),
      Buffer.from(table.dts.buffer),
      Buffer.from(table.key.buffer)
    ])
  )
}

export async function loadPacketTable(path: string): Promise<PacketTable> {
  const buffer = await readFile(path)
  const count = buffer.readUInt32LE(0)
  const aligned = new Uint8Array(buffer.subarray(8)).buffer
  const pts = new Float64Array(aligned, 0, count)
  const dts = new Float64Array(aligned, count * 8, count)
  const key = new Uint8Array(aligned, count * 16, count)
  return { pts, dts, key, displayOrder: Float64Array.from(pts).sort(), splicePointsMarked: buffer.readUInt32LE(4) === 1 }
}
