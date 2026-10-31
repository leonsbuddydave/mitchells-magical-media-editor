import { describe, expect, it } from 'vitest'
import { DEFAULT_TEMPLATE, renderFilename, uniqueName } from '../src/shared/filename'
import type { Clip } from '../src/shared/types'

const clip = (patch: Partial<Clip>): Clip => ({
  id: 'a', start: 0, end: 1, title: '', date: '', time: '', timeZone: '', people: [], location: '', place: null, tags: [], notes: '', exports: [], ...patch
})
const name = (patch: Partial<Clip>, template = DEFAULT_TEMPLATE): string =>
  renderFilename(template, clip(patch), { projectName: 'Tape 7', index: 3 })

describe('renderFilename', () => {
  it('fills every field', () => {
    expect(name({ date: '1994-12-25', title: 'Christmas', people: ['Mum', 'Dad'], location: 'Home' })).toBe(
      '1994-12-25 Christmas (Mum, Dad) @ Home'
    )
  })

  it('drops the punctuation around empty fields only', () => {
    expect(name({ title: 'Christmas', location: 'Home' })).toBe('Christmas @ Home')
    expect(name({ title: 'Christmas', people: ['Mum'] })).toBe('Christmas (Mum)')
    expect(name({ date: '1994', title: 'Christmas' })).toBe('1994 Christmas')
    expect(name({ location: 'Home' })).toBe('Home')
    expect(name({ title: 'Beach' }, '{date} - {title}')).toBe('Beach')
    expect(name({ date: '1994' }, '{date} - {title}')).toBe('1994')
  })

  it('keeps punctuation that belongs to the values or the template', () => {
    expect(name({ title: 'Mum & Dad - Paris' })).toBe('Mum & Dad - Paris')
    expect(name({ title: 'A', location: 'B' }, '{title} + {location}')).toBe('A + B')
  })

  it('falls back to a clip number when there is nothing to use', () => {
    expect(name({})).toBe('Clip 03')
  })

  it('supports project and position tokens', () => {
    expect(name({ title: 'Cake' }, '{project} {n} {title}')).toBe('Tape 7 03 Cake')
  })

  it('removes characters filesystems reject', () => {
    expect(name({ title: 'a/b:c*d?"e<f>g|h' })).toBe('a b c d e f g h')
    expect(name({ title: '../../etc/passwd' })).not.toContain('/')
    expect(name({ title: '...hidden' })).toBe('hidden')
    expect(name({ title: 'ends with dot.' })).toBe('ends with dot')
  })

  it('leaves unknown tokens visible so a typo gets noticed', () => {
    expect(name({ title: 'A' }, '{title} {oops}')).toBe('A {oops}')
  })

  it('stays within filesystem name limits on multi-byte text', () => {
    const long = name({ title: 'é'.repeat(300) })
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(230)
    expect(long).not.toContain('�')
  })
})

describe('uniqueName', () => {
  it('never reuses a name', () => {
    const taken = new Set(['a.mkv', 'a (2).mkv'])
    expect(uniqueName('a', 'mkv', (candidate) => taken.has(candidate))).toBe('a (3).mkv')
    expect(uniqueName('b', 'mkv', (candidate) => taken.has(candidate))).toBe('b.mkv')
  })
})
