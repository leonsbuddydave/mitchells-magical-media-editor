import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildFilmstrip, buildProxy, needsProxy } from '../src/main/analysis'
import { probeMedia, scanPackets } from '../src/main/probe'
import { FIXTURES, fixturePath } from './fixtures'

const workDir = mkdtempSync(join(tmpdir(), 'proxy-test-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

function countFrames(path: string): number {
  return Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path
    ]).toString()
  )
}

/** How well frame `a` of one file matches frame `b` of another, at the proxy's size. */
function psnr(proxy: string, a: number, source: string, b: number): number {
  const pick = (input: number, frame: number, label: string): string =>
    `[${input}:v]select='eq(n,${frame})',setpts=N/TB,scale=360:288:flags=bicubic,format=yuv420p,setsar=1[${label}]`
  const graph = `${pick(0, a, 'a')};${pick(1, b, 'b')};[a][b]psnr=stats_file=-[out]`
  const stats = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', proxy, '-i', source, '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-f', 'null', '-'],
    { maxBuffer: 1 << 24 }
  ).toString()
  const match = /psnr_avg:(\S+)/.exec(stats)
  return match?.[1] === 'inf' ? 100 : Number(match?.[1])
}

// The proxy is what the user marks against, so frame N on screen has to be frame N
// of the rip. Each of these needs a proxy, and covers a different timing quirk.
const CASES = ['mpeg2.mpg', 'h264-open.mkv', 'h264-interlaced.mkv', 'hevc.mkv', 'dv.avi', 'huffyuv.avi']

describe.each(CASES)('proxy of %s', (file) => {
  it('keeps every frame, each at its own position', async () => {
    const source = fixturePath(FIXTURES.find((fixture) => fixture.file === file)!)
    const media = await probeMedia(source)
    const table = await scanPackets(source)
    const offset = table.displayOrder[0] - media.startTime
    expect(needsProxy(media, offset)).toBe(true)

    const proxy = join(workDir, `${file}.mp4`)
    await buildProxy(source, media, offset, proxy)
    const frames = table.pts.length
    expect(countFrames(proxy)).toBe(frames)

    for (const frame of [Math.floor(frames / 3), frames - 40]) {
      const matched = psnr(proxy, frame, source, frame)
      expect(matched).toBeGreaterThan(psnr(proxy, frame, source, frame - 1))
      expect(matched).toBeGreaterThan(psnr(proxy, frame, source, frame + 1))
    }
  })
})

describe('filmstrip', () => {
  it('copes with a recording that has no hard cuts', async () => {
    const source = fixturePath(FIXTURES[0])
    const media = await probeMedia(source)
    const output = join(workDir, 'strip')
    const positions: number[] = []
    const { filmstrip, scenes } = await buildFilmstrip(source, media, output, { onProgress: (seconds) => positions.push(seconds) })
    expect(scenes).toEqual([])
    // Progress moves steadily through the whole file.
    expect(positions.length).toBeGreaterThan(500)
    expect(positions.at(-1)!).toBeGreaterThan(media.duration * 0.95)
    expect(filmstrip.sheets).toBeGreaterThan(0)
    expect(readdirSync(output)).toHaveLength(filmstrip.sheets)
  })
})

describe('interrupted runs', () => {
  it('finishes cleanly even if an earlier run left files or is still writing', async () => {
    const fixture = FIXTURES.find((f) => f.file === 'hevc.mkv')!
    const source = fixturePath(fixture)
    const media = await probeMedia(source)
    const table = await scanPackets(source)
    const offset = table.displayOrder[0] - media.startTime
    const output = join(workDir, 'race.mp4')
    await Promise.all([buildProxy(source, media, offset, output), buildProxy(source, media, offset, output)])
    expect(countFrames(output)).toBe(table.pts.length)
    const errors = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
    expect(errors).toBe('')
    expect(readdirSync(workDir).filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})
