import type { Clip } from './types'

export const DEFAULT_TEMPLATE = '{date} {title} ({people}) @ {location}'

export const TEMPLATE_TOKENS = ['date', 'title', 'people', 'location', 'tags', 'project', 'n'] as const

export interface FilenameContext {
  projectName: string
  /** 1-based position of the clip on the timeline. */
  index: number
}

const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f]/g
// Most filesystems cap a name at 255 bytes, and the extension and any " (2)"
// suffix still have to fit.
const MAX_NAME_BYTES = 230

function sanitize(name: string): string {
  return name.replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '')
}

function truncateBytes(name: string): string {
  const encoder = new TextEncoder()
  let chars = Array.from(name)
  while (encoder.encode(chars.join('')).length > MAX_NAME_BYTES) chars = chars.slice(0, -1)
  return chars.join('').trimEnd()
}

/** Stands in for a token with no value while the punctuation around it is cleaned up. */
const EMPTY = '\u0001'
const SEPARATORS = '[-–—@,_+&]+'
const EMPTY_IN_BRACKETS = new RegExp(`[(\\[{]\\s*${EMPTY}\\s*[)\\]}]`, 'g')
const SEPARATOR_BEFORE_EMPTY = new RegExp(`\\s*${SEPARATORS}\\s*${EMPTY}`, 'g')
const SEPARATOR_AT_START = new RegExp(`^[\\s${EMPTY}]*${EMPTY}\\s*${SEPARATORS}\\s*`)

/** Removes only the punctuation a template wrapped around a token that came up empty. */
function dropEmptyTokens(name: string): string {
  return name
    .replace(EMPTY_IN_BRACKETS, EMPTY)
    .replace(SEPARATOR_BEFORE_EMPTY, EMPTY)
    .replace(SEPARATOR_AT_START, '')
    .replaceAll(EMPTY, ' ')
}

export function renderFilename(template: string, clip: Clip, context: FilenameContext): string {
  const values: Record<string, string> = {
    date: clip.date,
    title: clip.title,
    people: clip.people.join(', '),
    location: clip.location,
    tags: clip.tags.join(', '),
    project: context.projectName,
    n: String(context.index).padStart(2, '0')
  }
  const filled = template.replace(/\{(\w+)\}/g, (match, token: string) =>
    token in values ? sanitize(values[token]) || EMPTY : match
  )
  return truncateBytes(sanitize(dropEmptyTokens(filled))) || `Clip ${values.n}`
}

/** Writes "name (2).ext" style names so nothing is ever overwritten. */
export function uniqueName(base: string, extension: string, taken: (name: string) => boolean): string {
  let candidate = `${base}.${extension}`
  for (let n = 2; taken(candidate); n += 1) candidate = `${base} (${n}).${extension}`
  return candidate
}
