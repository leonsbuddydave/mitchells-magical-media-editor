import { useEffect, useRef, useState } from 'react'
import type { Clip, KnownPlace, Place } from '../../../shared/types'

interface Props {
  clip: Clip
  known: KnownPlace[]
  onChange: (patch: Partial<Clip>, key?: string) => void
}

type Lookup =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'matches'; matches: Place[] }
  | { kind: 'none' }
  | { kind: 'failed'; message: string }

const COORDINATES = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/

function fromCoordinates(text: string): Place | null {
  const match = COORDINATES.exec(text)
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { name: text.trim(), address: '', latitude, longitude, timeZone: null }
}

function describe(place: Place): string {
  if (!place.address) return place.name
  return place.address.startsWith(place.name) ? place.address : `${place.name}, ${place.address}`
}

/**
 * Takes a place in plain words. A match is only saved once it's been confirmed,
 * because searches also hit unrelated businesses: "Grandma's house" finds a shop.
 * Confirmed names are remembered, and fill in without asking from then on.
 */
export function LocationField({ clip, known, onChange }: Props): React.JSX.Element {
  const [lookup, setLookup] = useState<Lookup>({ kind: 'idle' })
  const checked = useRef(clip.location.trim())
  const latestSearch = useRef(0)
  const focusMatches = useRef(false)
  const firstMatch = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (lookup.kind === 'searching') return
    // Not if they've since moved on: this would pull focus away mid-typing.
    const idle = document.activeElement === document.body
    if (lookup.kind === 'matches' && focusMatches.current && idle) firstMatch.current?.focus()
    focusMatches.current = false
  }, [lookup])

  const pick = (place: Place): void => {
    setLookup({ kind: 'idle' })
    onChange({ place, timeZone: clip.timeZone || place.timeZone || '' })
  }

  const type = (location: string): void => {
    latestSearch.current += 1
    setLookup({ kind: 'idle' })
    const pin = clip.place
    onChange(
      {
        location,
        // The pin belonged to the old text, as did any time zone that came with it.
        ...(pin ? { place: null, timeZone: clip.timeZone === pin.timeZone ? '' : clip.timeZone } : {})
      },
      `location:${clip.id}`
    )
  }

  const search = async (text: string): Promise<void> => {
    const search = (latestSearch.current += 1)
    setLookup({ kind: 'searching' })
    try {
      const matches = await window.api.searchPlaces(text)
      if (search !== latestSearch.current) return
      setLookup(matches.length > 0 ? { kind: 'matches', matches } : { kind: 'none' })
    } catch (reason) {
      if (search !== latestSearch.current) return
      const message = reason instanceof Error ? reason.message.replace(/^.*Error: /, '') : String(reason)
      setLookup({ kind: 'failed', message })
    }
  }

  const resolve = (): void => {
    const text = clip.location.trim()
    if (!text || clip.place || text === checked.current) return
    checked.current = text
    const place =
      fromCoordinates(text) ?? known.find((entry) => entry.label.trim().toLowerCase() === text.toLowerCase())?.place
    if (place) pick(place)
    else void search(text)
  }

  return (
    <div className="field">
      <label htmlFor="clip-location">Location</label>
      <input
        id="clip-location"
        list="known-locations"
        value={clip.location}
        placeholder="Butternut, WI or Walt Disney World"
        onChange={(event) => type(event.target.value)}
        onBlur={resolve}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          focusMatches.current = true
          event.currentTarget.blur()
        }}
      />
      <datalist id="known-locations">
        {known.map((entry) => (
          <option key={entry.label} value={entry.label} />
        ))}
      </datalist>

      {clip.place && (
        <p className="place-pin" data-testid="place-pin">
          <span>
            {describe(clip.place)}
            <small>
              {clip.place.latitude.toFixed(4)}, {clip.place.longitude.toFixed(4)}
            </small>
          </span>
          <button
            type="button"
            title="Keep the text, without coordinates"
            onClick={() => onChange({ place: null })}
          >
            Remove
          </button>
        </p>
      )}
      {lookup.kind === 'searching' && <p className="field-note">Looking up…</p>}
      {lookup.kind === 'none' && <p className="field-note">Not found on the map, so this is saved as text only.</p>}
      {lookup.kind === 'failed' && (
        <p className="field-note warn">
          {lookup.message} Saved as text only.{' '}
          <button type="button" className="link" onClick={() => void search(clip.location.trim())}>
            Try again
          </button>
        </p>
      )}
      {lookup.kind === 'idle' && !clip.place && clip.location.trim() && clip.location.trim() === checked.current && (
        <button type="button" className="link" onClick={() => void search(clip.location.trim())}>
          Find on map
        </button>
      )}
      {lookup.kind === 'matches' && (
        <div
          className="place-matches"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            setLookup({ kind: 'idle' })
          }}
        >
          <p>Is this the place?</p>
          {lookup.matches.map((place, index) => (
            <button
              type="button"
              key={`${place.latitude},${place.longitude}`}
              ref={index === 0 ? firstMatch : undefined}
              onClick={() => pick(place)}
            >
              {describe(place)}
            </button>
          ))}
          <button type="button" className="link" onClick={() => setLookup({ kind: 'idle' })}>
            None of these: keep as text only
          </button>
        </div>
      )}
    </div>
  )
}
