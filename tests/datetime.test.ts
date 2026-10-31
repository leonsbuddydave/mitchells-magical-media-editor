import { describe, expect, it } from 'vitest'
import { clipMoment, isValidTimeZone } from '../src/shared/datetime'
import { clipMetadata } from '../src/main/metadata'
import type { Clip } from '../src/shared/types'

const moment = (date: string, time = '', timeZone = '') => clipMoment({ date, time, timeZone }, 'America/Los_Angeles')

describe('clipMoment', () => {
  it('uses the offset that applied on the day, daylight saving included', () => {
    expect(moment('1994-07-04', '14:30', 'America/New_York')?.offset).toBe('-04:00')
    expect(moment('1994-01-04', '14:30', 'America/New_York')?.offset).toBe('-05:00')
    expect(moment('1994-07-04', '14:30', 'America/New_York')?.instant.toISOString()).toBe('1994-07-04T18:30:00.000Z')
  })

  it('uses the historic rules, not today\'s', () => {
    // US daylight saving started in April in 1994, but starts in March now.
    expect(moment('1994-03-20', '12:00', 'America/Chicago')?.offset).toBe('-06:00')
    expect(moment('2024-03-20', '12:00', 'America/Chicago')?.offset).toBe('-05:00')
  })

  it('keeps the calendar day on far-ahead time zones', () => {
    expect(moment('1994-07-04', '', 'Pacific/Auckland')?.instant.toISOString()).toBe('1994-07-04T00:00:00.000Z')
  })

  it('handles partial dates and ignores a time without a full date', () => {
    expect(moment('1994')?.local).toMatchObject({ year: 1994, month: 1, day: 1, hour: 12 })
    expect(moment('1994-07', '09:15')?.local).toMatchObject({ month: 7, day: 1, hour: 12 })
  })

  it('falls back to the given zone', () => {
    expect(moment('1994-07-04')?.offset).toBe('-07:00')
    expect(moment('1994-07-04', '', 'Not/AZone')?.offset).toBe('-07:00')
  })

  it('rejects dates that do not exist', () => {
    expect(moment('')).toBeNull()
    expect(moment('Summer 94')).toBeNull()
    expect(moment('1994-02-30')).toBeNull()
    expect(moment('1994-13-01')).toBeNull()
  })

  it('validates zones', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('Mars/Base')).toBe(false)
  })
})

describe('clipMetadata', () => {
  const clip: Clip = {
    id: 'c', start: 0, end: 1, title: 'T', date: '1994-07-04', time: '', timeZone: 'America/Chicago', people: [], location: 'Sydney',
    place: { name: 'Sydney', address: '', latitude: -33.8688, longitude: 151.2093, timeZone: 'Australia/Sydney' },
    tags: ['a', 'b'], notes: '', exports: []
  }

  it('gets the hemispheres right', () => {
    expect(clipMetadata(clip, 'Tape', 'mp4').apple).toContain('-Keys:GPSCoordinates=33.868800 S, 151.209300 E')
    expect(clipMetadata(clip, 'Tape', 'mov').ffmpeg).toContain('location=-33.8688+151.2093/')
    expect(clipMetadata(clip, 'Tape', 'mkv').ffmpeg).toContain('location_iso6709=-33.8688+151.2093/')
  })

  it('keeps the typed place name as text in every format', () => {
    expect(clipMetadata(clip, 'Tape', 'mp4').apple).toContain('-Keys:LocationName=Sydney')
    expect(clipMetadata(clip, 'Tape', 'mkv').ffmpeg).toContain('location=Sydney')
  })

  it('never puts plain text where coordinates belong', () => {
    const text = clipMetadata({ ...clip, place: null, location: "Grandma's house" }, 'Tape', 'mov')
    expect(text.ffmpeg.join(' ')).not.toContain('location=')
    expect(text.apple.join(' ')).not.toContain('GPSCoordinates')
  })
})
