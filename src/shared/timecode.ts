/** H:MM:SS:FF, using the rip's real frame rate for the frame count. */
export function formatTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(seconds * fps))
  const nominal = Math.max(1, Math.round(fps))
  const frames = totalFrames % nominal
  const whole = Math.floor(totalFrames / nominal)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  return `${h}:${pad(m)}:${pad(s)}:${pad(frames)}`
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
