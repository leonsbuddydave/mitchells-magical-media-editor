import { clipMoment } from '../shared/datetime'
import type { Clip, Container, Place } from '../shared/types'

export interface ClipMetadata {
  /** -metadata arguments for ffmpeg. */
  ffmpeg: string[]
  /**
   * exiftool arguments. ffmpeg can't write the moov/meta atom that Apple's software
   * reads, so its tags reach Apple apps only as title, artist and the like.
   */
  apple: string[]
  /** Finder and Spotlight take a video's date from the file itself. */
  fileDate: Date | null
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function signed(value: number, integerDigits: number): string {
  const [whole, fraction] = Math.abs(value).toFixed(4).split('.')
  return `${value < 0 ? '-' : '+'}${whole.padStart(integerDigits, '0')}.${fraction}`
}

function iso6709(place: Place): string {
  return `${signed(place.latitude, 2)}${signed(place.longitude, 3)}/`
}

function hemispheres(place: Place): string {
  const latitude = `${Math.abs(place.latitude).toFixed(6)} ${place.latitude < 0 ? 'S' : 'N'}`
  const longitude = `${Math.abs(place.longitude).toFixed(6)} ${place.longitude < 0 ? 'W' : 'E'}`
  return `${latitude}, ${longitude}`
}

export function clipMetadata(clip: Clip, projectName: string, container: Container): ClipMetadata {
  const moment = clipMoment(clip)
  const keywords = clip.tags.join(', ')
  const apple = container === 'mp4' || container === 'mov'
  const entries: Array<[string, string]> = [
    ['title', clip.title],
    ['date', clip.date],
    ['artist', clip.people.join(', ')],
    ['comment', clip.notes],
    ['album', projectName]
  ]
  if (moment) entries.push(['creation_time', moment.instant.toISOString()])
  if (!apple) {
    entries.push(['location', clip.location], ['keywords', keywords], ['time_zone', clip.timeZone])
    if (clip.place) entries.push(['location_iso6709', iso6709(clip.place)])
  } else if (clip.place && container === 'mov') {
    entries.push(['location', iso6709(clip.place)])
  }

  const tags: Array<[string, string]> = !apple
    ? []
    : [
        ['Title', clip.title],
        ['Artist', clip.people.join(', ')],
        ['Keywords', keywords],
        ['Description', clip.notes],
        ['LocationName', clip.location],
        ['GPSCoordinates', clip.place ? hemispheres(clip.place) : '']
      ]
  if (apple && moment) {
    const { year, month, day, hour, minute } = moment.local
    tags.push(['CreationDate', `${year}:${pad(month)}:${pad(day)} ${pad(hour)}:${pad(minute)}:00${moment.offset}`])
  }

  return {
    ffmpeg: entries.filter(([, value]) => value.trim()).flatMap(([key, value]) => ['-metadata', `${key}=${value}`]),
    apple: tags.filter(([, value]) => value.trim()).map(([key, value]) => `-Keys:${key}=${value}`),
    fileDate: moment?.instant ?? null
  }
}
