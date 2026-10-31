import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cutClip } from '../src/main/cutter'
import { clipMetadata } from '../src/main/metadata'
import { CancelledError, CancelToken } from '../src/main/ffmpeg'
import { sourceContainer } from '../src/shared/formats'
import { planCopy, planEncode, planSmart, type CutPlan } from '../src/main/cutplan'
import { markIdrFrames, probeMedia, scanPackets, summarize, type PacketTable } from '../src/main/probe'
import { FIXTURES, fixturePath, type Fixture } from './fixtures'
import type { Clip, Container, MediaInfo } from '../src/shared/types'

const workDir = mkdtempSync(join(tmpdir(), 'cutter-test-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

const clip: Clip = {
  id: 'c1', start: 0, end: 0, title: 'Beach day', date: '1994-07', time: '', timeZone: '', people: ['Mum', 'Dad'],
  location: 'Cape Cod', place: null, tags: ['holiday'], notes: 'First swim', exports: []
}

/** Hash of every decoded frame, in display order. */
function frameHashes(path: string): string[] {
  const output = execFileSync(
    'ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'yuv422p10le', '-f', 'framemd5', '-'],
    { maxBuffer: 1 << 28 }
  ).toString()
  return output.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').at(-1)!.trim())
}

/** Decoder complaints; a clean file produces none. */
function decodeErrors(path: string): string {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-f', 'null', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  })
}

function psnr(reference: string, firstFrame: number, frames: number, output: string, outputFirst: number): number {
  const filter =
    `[0:v]trim=start_frame=${outputFirst}:end_frame=${outputFirst + frames},setpts=PTS-STARTPTS,format=yuv422p10le[a];` +
    `[1:v]trim=start_frame=${firstFrame}:end_frame=${firstFrame + frames},setpts=PTS-STARTPTS,format=yuv422p10le[b];` +
    `[a][b]psnr=stats_file=-[out]`
  const stats = execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-i', reference, '-filter_complex', filter, '-map', '[out]', '-f', 'null', '-'], {
    maxBuffer: 1 << 26
  }).toString()
  const values = stats.split('\n').filter(Boolean).map((l) => {
    const match = /psnr_avg:(\S+)/.exec(l)
    return match && match[1] !== 'inf' ? Number(match[1]) : 100
  })
  return Math.min(...values)
}

function mono(path: string): Int16Array {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'],
    { maxBuffer: 1 << 29 }
  )
  return new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1)
}

/**
 * How far the output's audio sits from where the video says it should, in
 * seconds. Finds where a slice of the output occurs in the source audio.
 */
function syncError(source: string, sourceSeconds: number, output: string): number {
  const videoStart = Number(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', output]).toString()
  ) || 0
  const original = mono(source)
  const cut = mono(output)
  const rate = 48000
  const probeAt = rate * 2
  const probeLength = 2400
  const expected = Math.round((sourceSeconds - videoStart) * rate) + probeAt
  const reach = rate * 3
  let best = Number.POSITIVE_INFINITY
  let bestAt = 0
  for (let at = Math.max(0, expected - reach); at < expected + reach; at += 1) {
    let cost = 0
    for (let i = 0; i < probeLength && cost < best; i += 16) {
      const delta = original[at + i] - cut[probeAt + i]
      cost += delta * delta
    }
    if (cost < best) {
      best = cost
      bestAt = at
    }
  }
  return (bestAt - expected) / rate
}

interface Loaded { path: string; media: MediaInfo; table: PacketTable; hashes: string[] }

const loaded = new Map<string, Loaded>()
async function load(fixture: Fixture): Promise<Loaded> {
  const cached = loaded.get(fixture.file)
  if (cached) return cached
  const path = fixturePath(fixture)
  const media = await probeMedia(path)
  const table = await scanPackets(path)
  if (media.video.codec === 'h264') await markIdrFrames(path, table)
  const value = { path, media, table, hashes: frameHashes(path) }
  loaded.set(fixture.file, value)
  return value
}

async function run(source: Loaded, plan: CutPlan, container: Container, name: string): Promise<string> {
  const outputPath = join(workDir, `${name}.${container}`)
  const tags = clipMetadata(clip, 'Tape 1', container)
  const result = await cutClip({
    sourcePath: source.path, media: source.media, table: source.table, plan, container,
    encodePreset: null, metadata: tags.ffmpeg, appleTags: tags.apple, fileDate: tags.fileDate, outputPath
  })
  expect(result.warning).toBeNull()
  return outputPath
}

const WANTED_FIRST = 97
const WANTED_LAST = 503
/** Starts over 20s in, far enough that every path has to really seek. */
const LATE_FIRST = 531
const LATE_LAST = 702

describe.each(FIXTURES)('$file', (fixture) => {
  it('indexes packets', async () => {
    const source = await load(fixture)
    expect(summarize(source.table).intraOnly).toBe(fixture.intraOnly)
    expect(source.hashes.length).toBe(source.table.pts.length)
  })

  it('stream copies with untouched frames covering the marks', async () => {
    const source = await load(fixture)
    const plan = planCopy(source.table, WANTED_FIRST, WANTED_LAST)
    if (fixture.intraOnly) expect([plan.first, plan.last]).toEqual([WANTED_FIRST, WANTED_LAST])
    expect(plan.first).toBeLessThanOrEqual(WANTED_FIRST)
    expect(plan.last).toBeGreaterThanOrEqual(WANTED_LAST)
    const output = await run(source, plan, fixture.file.endsWith('.mpg') ? 'mpg' : 'mkv', `${fixture.file}-copy`)
    expect(frameHashes(output).slice(0, plan.frames)).toEqual(source.hashes.slice(plan.first, plan.last))
    expect(Math.abs(syncError(source.path, source.table.displayOrder[plan.first] - source.media.startTime, output))).toBeLessThan(0.03)
  })

  it('stream copies late in the file, after a real seek', async () => {
    const source = await load(fixture)
    const plan = planCopy(source.table, LATE_FIRST, LATE_LAST)
    const output = await run(source, plan, fixture.file.endsWith('.mpg') ? 'mpg' : 'mkv', `${fixture.file}-late-copy`)
    expect(frameHashes(output).slice(0, plan.frames)).toEqual(source.hashes.slice(plan.first, plan.last))
    expect(Math.abs(syncError(source.path, source.table.displayOrder[plan.first] - source.media.startTime, output))).toBeLessThan(0.03)
  })

  it.runIf(fixture.smart).each([
    ['near the start', WANTED_FIRST, WANTED_LAST],
    ['after a real seek', LATE_FIRST, LATE_LAST]
  ])('smart cuts on the exact frames %s', async (label, wantedFirst, wantedLast) => {
    const source = await load(fixture)
    const plan = planSmart(source.table, wantedFirst, wantedLast)
    expect(plan.frames).toBe(wantedLast - wantedFirst)
    if (!fixture.fewSplicePoints) expect(plan.reencodedFrames).toBeLessThan(plan.frames / 2)
    const output = await run(source, plan, 'mkv', `${fixture.file}-smart-${label}`)

    const hashes = frameHashes(output)
    expect(hashes.length).toBe(plan.frames)
    let position = 0
    for (const segment of plan.segments) {
      const frames = segment.last - segment.first
      if (segment.kind === 'copy') {
        expect(hashes.slice(position, position + frames)).toEqual(source.hashes.slice(segment.first, segment.last))
      } else {
        expect(psnr(source.path, segment.first, frames, output, position)).toBeGreaterThan(38)
      }
      position += frames
    }
    expect(decodeErrors(output)).toBe('')
    expect(Math.abs(syncError(source.path, source.table.displayOrder[plan.first] - source.media.startTime, output))).toBeLessThan(0.03)
  })
})

describe('other outputs', () => {
  it('leaves nothing behind when cancelled', async () => {
    const source = await load(FIXTURES[0])
    const directory = join(workDir, 'cancel')
    const token = new CancelToken()
    const outputPath = join(directory, 'clip.mkv')
    const cut = cutClip({
      sourcePath: source.path, media: source.media, table: source.table, plan: planEncode(0, 700), container: 'mkv',
      encodePreset: 'hevc', metadata: [], outputPath, token,
      onProgress: () => token.cancel()
    })
    await expect(cut).rejects.toBeInstanceOf(CancelledError)
    expect(readdirSync(directory)).toEqual([])
  })

  it('reads MOV as its own container', async () => {
    const source = await load(FIXTURES.find((f) => f.file === 'h264-nobframes.mov')!)
    expect(sourceContainer(source.media)).toBe('mov')
    expect(sourceContainer((await load(FIXTURES[0])).media)).toBe('mp4')
  })

  it.each(['mp4', 'mov'] as const)('smart cuts H.264 into %s', async (container) => {
    const source = await load(FIXTURES[0])
    const plan = planSmart(source.table, WANTED_FIRST, WANTED_LAST)
    const output = await run(source, plan, container, `smart-${container}`)
    const hashes = frameHashes(output)
    expect(hashes.length).toBe(plan.frames)
    expect(decodeErrors(output)).toBe('')
    const copy = plan.segments.find((s) => s.kind === 'copy')!
    const offset = copy.first - plan.first
    expect(hashes.slice(offset, offset + copy.last - copy.first)).toEqual(source.hashes.slice(copy.first, copy.last))
  })

  it.each([
    ['h264-closed.mp4', WANTED_FIRST, WANTED_LAST],
    ['h264-closed.mp4', LATE_FIRST, LATE_LAST],
    ['mpeg2.mpg', LATE_FIRST, LATE_LAST]
  ])('re-encodes the exact frames of %s losslessly with FFV1 (%i-%i)', async (file, first, last) => {
    const source = await load(FIXTURES.find((f) => f.file === file)!)
    const plan = planEncode(first, last)
    const outputPath = join(workDir, `ffv1-${file}-${first}.mkv`)
    await cutClip({
      sourcePath: source.path, media: source.media, table: source.table, plan, container: 'mkv',
      encodePreset: 'ffv1', metadata: [], outputPath
    })
    expect(frameHashes(outputPath)).toEqual(source.hashes.slice(first, last))
    expect(Math.abs(syncError(source.path, source.table.displayOrder[first] - source.media.startTime, outputPath))).toBeLessThan(0.03)
  })

  it('writes metadata that can be read back', async () => {
    const source = await load(FIXTURES[0])
    const output = await run(source, planSmart(source.table, WANTED_FIRST, WANTED_LAST), 'mp4', 'metadata')
    const tags = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', output]).toString()).format.tags
    expect(tags).toMatchObject({ title: 'Beach day', date: '1994-07', artist: 'Mum, Dad', comment: 'First swim' })
  })

  it.each(['mp4', 'mov'] as const)('tags %s so Apple software can read place and time, leaving the video alone', async (container) => {
    const source = await load(FIXTURES[0])
    const plan = planSmart(source.table, WANTED_FIRST, WANTED_LAST)
    const placed: Clip = {
      ...clip, title: 'São Paulo "trip"', date: '1994-07-04', time: '14:30', timeZone: 'America/Chicago',
      location: 'Butternut, WI',
      place: { name: 'Butternut', address: 'Butternut, WI', latitude: 46.0131484, longitude: -90.4966458, timeZone: 'America/Chicago' }
    }
    const tags = clipMetadata(placed, 'Tape 1', container)
    const plainPath = join(workDir, `plain.${container}`)
    const taggedPath = join(workDir, `tagged.${container}`)
    const base = { sourcePath: source.path, media: source.media, table: source.table, plan, container, encodePreset: null }
    await cutClip({ ...base, metadata: tags.ffmpeg, outputPath: plainPath })
    const result = await cutClip({ ...base, metadata: tags.ffmpeg, appleTags: tags.apple, fileDate: tags.fileDate, outputPath: taggedPath })
    expect(result.warning).toBeNull()

    const read = JSON.parse(execFileSync('exiftool', ['-j', '-n', '-Keys:all', taggedPath]).toString())[0]
    expect(read.GPSCoordinates).toContain('46.013148 -90.496646')
    expect(read.LocationName).toBe('Butternut, WI')
    expect(read.CreationDate).toBe('1994:07:04 14:30:00-05:00')
    expect(read.Title).toBe('São Paulo "trip"')

    const packets = (path: string): string =>
      execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0', '-c', 'copy', '-f', 'framemd5', '-'], { maxBuffer: 1 << 26 })
        .toString().split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split(',').at(-1)).join()
    expect(packets(taggedPath)).toBe(packets(plainPath))
    expect(statSync(taggedPath).mtime.toISOString()).toBe('1994-07-04T19:30:00.000Z')
  })

  it('still exports, with a warning, if exiftool is missing', async () => {
    const source = await load(FIXTURES[0])
    const previous = process.env.EXIFTOOL_PATH
    process.env.EXIFTOOL_PATH = '/nonexistent/exiftool'
    try {
      const outputPath = join(workDir, 'no-exiftool.mp4')
      const result = await cutClip({
        sourcePath: source.path, media: source.media, table: source.table,
        plan: planSmart(source.table, WANTED_FIRST, WANTED_LAST), container: 'mp4', encodePreset: null,
        metadata: [], appleTags: ['-Keys:Title=A'], outputPath
      })
      expect(result.warning).toContain('Location and date tags')
      expect(existsSync(outputPath)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.EXIFTOOL_PATH
      else process.env.EXIFTOOL_PATH = previous
    }
  })

  it('keeps sync when audio has to be transcoded for the container', async () => {
    const source = await load(FIXTURES[1])
    const plan = planSmart(source.table, WANTED_FIRST, WANTED_LAST)
    const output = await run(source, plan, 'mp4', 'transcoded-audio')
    const codecs = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', output]).toString()
    expect(codecs).toContain('alac')
    expect(Math.abs(syncError(source.path, source.table.displayOrder[plan.first] - source.media.startTime, output))).toBeLessThan(0.03)
  })

  it('reaches the very last frame of the rip', async () => {
    const source = await load(FIXTURES[0])
    const frames = source.table.displayOrder.length
    const plan = planSmart(source.table, frames - 100, frames)
    const output = await run(source, plan, 'mkv', 'tail')
    const hashes = frameHashes(output)
    expect(hashes.length).toBe(100)
    const copy = plan.segments.find((s) => s.kind === 'copy')
    if (copy) expect(hashes.at(-1)).toBe(source.hashes.at(-1))
  })

  it('handles a clip that sits inside a single GOP', async () => {
    const source = await load(FIXTURES[0])
    const plan = planSmart(source.table, 101, 110)
    expect(plan.reencodedFrames).toBe(9)
    const output = await run(source, plan, 'mp4', 'one-gop')
    expect(frameHashes(output).length).toBe(9)
  })
})
