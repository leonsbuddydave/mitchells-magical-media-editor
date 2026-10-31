const SHUTTLE_RATES = [1, 2, 4, 8]
const REVERSE_TICK_MS = 66

/**
 * Owns the video element, outside React so the playhead can update every frame
 * without re-rendering the app. Times are always on the rip's frame grid.
 */
export class Playback {
  private video: HTMLVideoElement | null = null
  private listeners = new Set<() => void>()
  private frameCallback = 0
  private pendingSeek: number | null = null
  private reverseTimer: number | null = null
  private shuttleIndex = -1
  private shuttleDirection = 0

  time = 0
  fps = 25
  duration = 0

  configure(fps: number, duration: number): void {
    this.fps = fps
    this.duration = duration
  }

  attach(video: HTMLVideoElement | null): void {
    this.stopReverse()
    if (this.video && this.frameCallback) this.video.cancelVideoFrameCallback(this.frameCallback)
    this.video = video
    this.pendingSeek = null
    this.frameCallback = 0
    this.shuttleIndex = -1
    this.shuttleDirection = 0
    this.time = 0
    if (video) {
      video.addEventListener('seeked', this.onSeeked)
      this.watchFrames()
    }
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get playing(): boolean {
    return this.reverseTimer !== null || (this.video !== null && !this.video.paused)
  }

  get rate(): number {
    return this.shuttleDirection * (SHUTTLE_RATES[this.shuttleIndex] ?? 1)
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  private watchFrames(): void {
    const video = this.video
    if (!video) return
    this.frameCallback = video.requestVideoFrameCallback((_now, metadata) => {
      // While a seek is queued the target is the truth, not the outgoing frame.
      if (this.pendingSeek === null && !video.seeking) {
        this.time = this.snap(metadata.mediaTime)
        this.notify()
      }
      this.watchFrames()
    })
  }

  private onSeeked = (): void => {
    const next = this.pendingSeek
    if (next !== null && this.video) {
      this.pendingSeek = null
      this.video.currentTime = next
    }
    this.notify()
  }

  snap(seconds: number): number {
    const lastFrame = Math.max(0, Math.round(this.duration * this.fps) - 1)
    const frame = Math.min(lastFrame, Math.max(0, Math.round(seconds * this.fps)))
    return frame / this.fps
  }

  seek(seconds: number): void {
    const video = this.video
    this.time = this.snap(seconds)
    this.notify()
    if (!video) return
    // Aiming at the middle of a frame avoids showing its neighbour after rounding.
    const target = this.time + 0.5 / this.fps
    if (video.seeking) this.pendingSeek = target
    else video.currentTime = target
  }

  step(frames: number): void {
    this.halt()
    this.seek(this.time + frames / this.fps)
  }

  jump(seconds: number): void {
    this.seek(this.time + seconds)
  }

  togglePlay(): void {
    if (this.playing) this.halt()
    else this.playForward(0)
  }

  private playForward(index: number): void {
    const video = this.video
    if (!video) return
    this.stopReverse()
    this.shuttleIndex = index
    this.shuttleDirection = 1
    video.playbackRate = SHUTTLE_RATES[index]
    void video.play().catch(() => undefined)
    this.notify()
  }

  private playReverse(index: number): void {
    const video = this.video
    if (!video) return
    video.pause()
    this.stopReverse()
    this.shuttleIndex = index
    this.shuttleDirection = -1
    const speed = SHUTTLE_RATES[index]
    this.reverseTimer = window.setInterval(() => {
      if (this.time <= 0) this.halt()
      else this.seek(this.time - (speed * REVERSE_TICK_MS) / 1000)
    }, REVERSE_TICK_MS)
    this.notify()
  }

  /** J and L: pressing the same way again goes faster, the other way slows first. */
  shuttle(direction: 1 | -1): void {
    const next = this.shuttleDirection === direction ? Math.min(this.shuttleIndex + 1, SHUTTLE_RATES.length - 1) : 0
    if (direction > 0) this.playForward(next)
    else this.playReverse(next)
  }

  private stopReverse(): void {
    if (this.reverseTimer !== null) window.clearInterval(this.reverseTimer)
    this.reverseTimer = null
  }

  halt(): void {
    this.stopReverse()
    this.shuttleIndex = -1
    this.shuttleDirection = 0
    if (this.video) {
      this.video.pause()
      this.video.playbackRate = 1
    }
    this.notify()
  }
}
