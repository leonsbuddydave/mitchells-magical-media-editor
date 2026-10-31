import type { Clip } from './types'

const DATE = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/
const TIME = /^(\d{2}):(\d{2})$/

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** Minutes ahead of UTC in a zone at an instant, by that date's own rules. */
function offsetMinutes(utcMilliseconds: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(utcMilliseconds)
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  const wall = Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second'))
  return Math.round((wall - utcMilliseconds) / 60000)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatOffset(minutes: number): string {
  const size = Math.abs(minutes)
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(size / 60))}:${pad(size % 60)}`
}

export interface ClipMoment {
  instant: Date
  /** The same moment as wall-clock parts, for formats that keep the offset. */
  local: { year: number; month: number; day: number; hour: number; minute: number }
  offset: string
}

function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * When a clip was recorded, as well as it's known. Formats need a full moment, so
 * partial dates use their earliest day, and a missing time uses noon, which keeps
 * the calendar date intact wherever the file is viewed. With no zone, the computer's
 * own is used for the same reason.
 */
export function clipMoment(clip: Pick<Clip, 'date' | 'time' | 'timeZone'>, fallbackZone = hostTimeZone()): ClipMoment | null {
  const match = DATE.exec(clip.date.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2] ?? 1)
  const day = Number(match[3] ?? 1)
  const clock = match[3] ? TIME.exec(clip.time) : null
  const hour = clock ? Number(clock[1]) : 12
  const minute = clock ? Number(clock[2]) : 0

  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const check = new Date(wall)
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) return null

  const zone = isValidTimeZone(clip.timeZone) ? clip.timeZone : fallbackZone
  // The offset depends on the instant being worked out, so settle it in two steps.
  const offset = offsetMinutes(wall - offsetMinutes(wall, zone) * 60000, zone)
  return {
    instant: new Date(wall - offset * 60000),
    local: { year, month, day, hour, minute },
    offset: formatOffset(offset)
  }
}
