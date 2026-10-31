import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const FIXTURE_DIR = join(__dirname, '.fixtures', 'noise-audio')

const VIDEO = 'testsrc2=s=720x576:r=25:d=30,noise=alls=12:allf=t,setsar=16/15'
const FIELDS = 'testsrc2=s=720x576:r=50:d=30,noise=alls=12:allf=t,tinterlace=interleave_top,setsar=16/15'
// Noise, unlike a tone, has one unambiguous alignment against the source.
const AUDIO = 'anoisesrc=r=48000:d=30:a=0.4:seed=7'

export interface Fixture {
  file: string
  video: string
  args: string[]
  /** Frame-accurate cuts expected via plain stream copy. */
  intraOnly: boolean
  smart: boolean
  /** Open GOP: smart cut stays exact but has to re-encode most frames. */
  fewSplicePoints?: boolean
}

export const FIXTURES: Fixture[] = [
  { file: 'h264-closed.mp4', video: VIDEO, intraOnly: false, smart: true,
    args: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-g', '50', '-bf', '3', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] },
  { file: 'h264-nobframes.mov', video: VIDEO, intraOnly: false, smart: true,
    args: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-g', '50', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le'] },
  { file: 'h264-open.mkv', video: VIDEO, intraOnly: false, smart: true, fewSplicePoints: true,
    args: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-g', '50', '-bf', '3', '-x264opts', 'open-gop=1', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] },
  { file: 'h264-interlaced.mkv', video: FIELDS, intraOnly: false, smart: true,
    args: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-g', '50', '-flags', '+ildct+ilme', '-x264opts', 'tff=1', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le'] },
  { file: 'hevc.mkv', video: VIDEO, intraOnly: false, smart: true,
    args: ['-c:v', 'libx265', '-x265-params', 'log-level=error:keyint=50', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] },
  { file: 'mpeg2.mpg', video: VIDEO, intraOnly: false, smart: true,
    args: ['-c:v', 'mpeg2video', '-b:v', '5M', '-g', '15', '-bf', '2', '-c:a', 'mp2', '-b:a', '224k'] },
  { file: 'mpeg4.avi', video: VIDEO, intraOnly: false, smart: false,
    args: ['-c:v', 'mpeg4', '-q:v', '3', '-g', '50', '-c:a', 'mp3'] },
  { file: 'dv.avi', video: VIDEO, intraOnly: true, smart: false,
    args: ['-c:v', 'dvvideo', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le'] },
  { file: 'ffv1.mkv', video: VIDEO, intraOnly: true, smart: false,
    args: ['-c:v', 'ffv1', '-level', '3', '-g', '1', '-c:a', 'flac'] },
  { file: 'huffyuv.avi', video: VIDEO, intraOnly: true, smart: false,
    args: ['-c:v', 'huffyuv', '-c:a', 'pcm_s16le'] },
  { file: 'prores.mov', video: VIDEO, intraOnly: true, smart: false,
    args: ['-c:v', 'prores_ks', '-profile:v', '2', '-c:a', 'pcm_s16le'] }
]

export function fixturePath(fixture: Fixture): string {
  const path = join(FIXTURE_DIR, fixture.file)
  if (existsSync(path)) return path
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const partial = join(FIXTURE_DIR, `partial-${fixture.file}`)
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', fixture.video, '-f', 'lavfi', '-i', AUDIO,
    ...fixture.args, partial
  ])
  renameSync(partial, path)
  return path
}
