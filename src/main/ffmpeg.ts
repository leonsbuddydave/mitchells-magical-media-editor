import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'

const SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

function locate(binary: string, override: string | undefined): string | null {
  if (override) return override
  const dirs = [...(process.env.PATH ?? '').split(':').filter(Boolean), ...SEARCH_DIRS]
  for (const dir of dirs) {
    const candidate = join(dir, binary)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

let cached: { ffmpeg: string; ffprobe: string } | null = null

export function binaries(): { ffmpeg: string; ffprobe: string } {
  if (cached) return cached
  const ffmpeg = locate('ffmpeg', process.env.FFMPEG_PATH)
  const ffprobe = locate('ffprobe', process.env.FFPROBE_PATH)
  if (!ffmpeg || !ffprobe) {
    throw new Error('ffmpeg and ffprobe were not found. Install them with: brew install ffmpeg')
  }
  cached = { ffmpeg, ffprobe }
  return cached
}

/** exiftool is optional: without it, only the location and time tags are lost. */
export function exiftoolPath(): string | null {
  const override = process.env.EXIFTOOL_PATH
  if (override) return existsSync(override) ? override : null
  return locate('exiftool', undefined)
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

/** Lets a caller stop whichever ffmpeg process is currently running for it. */
export class CancelToken {
  cancelled = false
  private child: ChildProcess | null = null

  attach(child: ChildProcess): void {
    this.child = child
  }

  detach(): void {
    this.child = null
  }

  cancel(): void {
    this.cancelled = true
    this.child?.kill('SIGKILL')
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new CancelledError()
  }
}

export interface RunOptions {
  token?: CancelToken
  onLine?: (line: string) => void
  /** Called with seconds of output written so far. Implies -progress. */
  onProgress?: (seconds: number) => void
}

/** ffmpeg ends every failure with lines about its threads; the cause is above them. */
const BOILERPLATE = /Task finished with|Terminating thread|Last message repeated|Nothing was written into output/

function lastLines(text: string, count: number): string {
  return text
    .trim()
    .split('\n')
    .filter((line) => !BOILERPLATE.test(line))
    .slice(-count)
    .join('\n')
}

function exec(binary: string, args: string[], options: RunOptions): Promise<{ stdout: string; stderr: string }> {
  options.token?.throwIfCancelled()
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    options.token?.attach(child)
    const keepStdout = !options.onLine && !options.onProgress
    let stdout = ''
    let stderr = ''
    let pending = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (keepStdout) stdout += chunk
      else {
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          options.onLine?.(line)
          if (options.onProgress && line.startsWith('out_time_us=')) {
            const micros = Number(line.slice('out_time_us='.length))
            if (Number.isFinite(micros) && micros >= 0) options.onProgress(micros / 1e6)
          }
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      options.token?.detach()
      if (pending) options.onLine?.(pending)
      if (options.token?.cancelled) reject(new CancelledError())
      else if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(lastLines(stderr, 4) || `${binary} exited with code ${code}`))
    })
  })
}

export function exiftool(binary: string, args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return exec(binary, args, options)
}

export function ffmpeg(args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const progress = options.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []
  return exec(binaries().ffmpeg, ['-hide_banner', '-loglevel', 'error', ...progress, ...args], options)
}

export function ffprobe(args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return exec(binaries().ffprobe, ['-hide_banner', '-loglevel', 'error', ...args], options)
}
