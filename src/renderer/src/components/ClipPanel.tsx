import { forwardRef, useImperativeHandle, useRef } from 'react'
import { clipMoment, isValidTimeZone } from '../../../shared/datetime'
import { renderFilename } from '../../../shared/filename'
import { formatDuration, formatTimecode } from '../../../shared/timecode'
import type { Clip, Project, Suggestions } from '../../../shared/types'
import { clipColor } from '../colors'
import { LocationField } from './LocationField'
import { TagInput } from './TagInput'

export interface ClipPanelHandle {
  focusTitle: () => void
}

interface Props {
  project: Project
  clips: Clip[]
  selectedId: string | null
  suggestions: Suggestions
  onSelect: (id: string) => void
  onChange: (id: string, patch: Partial<Clip>, key?: string) => void
  onDelete: (id: string) => void
  onCopyPrevious: (id: string) => void
}

const VALID_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/

export const ClipPanel = forwardRef<ClipPanelHandle, Props>(function ClipPanel(props, handle) {
  const { project, clips, selectedId, suggestions, onSelect, onChange, onDelete, onCopyPrevious } = props
  const titleRef = useRef<HTMLInputElement>(null)
  useImperativeHandle(handle, () => ({
    focusTitle: () => {
      titleRef.current?.focus()
      titleRef.current?.select()
    }
  }))

  const ordered = [...clips].sort((a, b) => a.start - b.start)
  const selectedIndex = ordered.findIndex((clip) => clip.id === selectedId)
  const selected = ordered[selectedIndex]
  const fps = project.media.video.fps
  const moment = selected ? clipMoment(selected) : null
  const leaveField = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') event.currentTarget.blur()
  }

  return (
    <section className="clip-panel">
      <header className="panel-header">
        <h2>Clips</h2>
        <span>{clips.length === 0 ? '' : `${clips.length} marked`}</span>
      </header>
      {ordered.length === 0 ? (
        <div className="empty-clips">
          <p>
            Scrub to where a clip begins and press <kbd>I</kbd>, then to where it ends and press <kbd>O</kbd>.
          </p>
          <p>Amber triangles on the timeline show likely cuts between recordings. Press <kbd>N</kbd> to jump between them.</p>
        </div>
      ) : (
        <ol className="clip-list">
          {ordered.map((clip, index) => (
            <li key={clip.id}>
              <button
                className={`clip-row${clip.id === selectedId ? ' selected' : ''}`}
                onClick={() => onSelect(clip.id)}
                data-testid="clip-row"
              >
                <span className="swatch" style={{ background: clipColor(index) }} />
                <span className="clip-title">{clip.title || `Untitled clip ${index + 1}`}</span>
                {clip.exports.length > 0 && <span className="exported" title="Exported">✓</span>}
                <span className="clip-time">{formatDuration(clip.end - clip.start)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {selected && (
        <form className="inspector" onSubmit={(event) => event.preventDefault()}>
          <div className="inspector-range">
            {formatTimecode(selected.start, fps)} → {formatTimecode(selected.end, fps)}
          </div>
          <div className="field">
            <label htmlFor="clip-title">Title</label>
            <input
              id="clip-title"
              ref={titleRef}
              value={selected.title}
              placeholder="Christmas morning"
              onChange={(event) => onChange(selected.id, { title: event.target.value }, `title:${selected.id}`)}
              onKeyDown={leaveField}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="clip-date">Date</label>
              <input
                id="clip-date"
                value={selected.date}
                placeholder="1994 or 1994-12-25"
                aria-invalid={selected.date !== '' && !VALID_DATE.test(selected.date)}
                onChange={(event) => onChange(selected.id, { date: event.target.value }, `date:${selected.id}`)}
                onKeyDown={leaveField}
              />
            </div>
            <div className="field time-field">
              <label htmlFor="clip-time">Time</label>
              <input
                id="clip-time"
                type="time"
                value={selected.time}
                disabled={!FULL_DATE.test(selected.date)}
                title={FULL_DATE.test(selected.date) ? undefined : 'Needs a full date'}
                onChange={(event) => onChange(selected.id, { time: event.target.value }, `time:${selected.id}`)}
                onKeyDown={leaveField}
              />
            </div>
          </div>
          {selected.date !== '' && !VALID_DATE.test(selected.date) && (
            <p className="field-note">Use YYYY, YYYY-MM or YYYY-MM-DD so apps can sort by it.</p>
          )}
          <LocationField
            key={selected.id}
            clip={selected}
            known={suggestions.places}
            onChange={(patch, key) => onChange(selected.id, patch, key)}
          />
          <div className="field">
            <label htmlFor="clip-zone">Time zone</label>
            <input
              id="clip-zone"
              list="known-zones"
              value={selected.timeZone}
              placeholder="Set by the location"
              spellCheck={false}
              aria-invalid={selected.timeZone !== '' && !isValidTimeZone(selected.timeZone)}
              onChange={(event) => onChange(selected.id, { timeZone: event.target.value }, `zone:${selected.id}`)}
              onKeyDown={leaveField}
            />
            <datalist id="known-zones">
              {Intl.supportedValuesOf('timeZone').map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            {isValidTimeZone(selected.timeZone) && moment && (
              <p className="field-note">UTC{moment.offset} on this date</p>
            )}
          </div>
          <TagInput
            label="People"
            values={selected.people}
            suggestions={suggestions.people}
            placeholder="Type a name, press Enter"
            onChange={(people) => onChange(selected.id, { people })}
          />
          <TagInput
            label="Tags"
            values={selected.tags}
            suggestions={suggestions.tags}
            placeholder="birthday, holiday…"
            onChange={(tags) => onChange(selected.id, { tags })}
          />
          <div className="field">
            <label htmlFor="clip-notes">Notes</label>
            <textarea
              id="clip-notes"
              rows={2}
              value={selected.notes}
              onChange={(event) => onChange(selected.id, { notes: event.target.value }, `notes:${selected.id}`)}
            />
          </div>
          <p className="filename-preview" title="Output filename">
            {renderFilename(project.exportSettings.template, selected, {
              projectName: project.name,
              index: selectedIndex + 1
            })}
          </p>
          <div className="inspector-actions">
            <button type="button" onClick={() => onCopyPrevious(selected.id)} disabled={selectedIndex === 0}>
              Copy tags from previous clip
            </button>
            <button type="button" className="danger" onClick={() => onDelete(selected.id)}>
              Delete clip
            </button>
          </div>
        </form>
      )}
    </section>
  )
})
