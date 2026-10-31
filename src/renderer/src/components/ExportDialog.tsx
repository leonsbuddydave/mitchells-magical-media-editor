import { useEffect, useMemo, useState } from 'react'
import { renderFilename, TEMPLATE_TOKENS } from '../../../shared/filename'
import {
  AUDIO_FALLBACK,
  CONTAINER_LABELS,
  ENCODE_PRESETS,
  containersFor,
  defaultContainer,
  methodsFor,
  supportsAudio
} from '../../../shared/formats'
import { formatDuration } from '../../../shared/timecode'
import type {
  Clip,
  Container,
  CutMethod,
  CutPreview,
  EncodePreset,
  ExportSettings,
  ExportStatus,
  Project
} from '../../../shared/types'

interface Props {
  project: Project
  clips: Clip[]
  status: ExportStatus | null
  onClose: () => void
}

function describeCut(cut: CutPreview | undefined): string {
  if (!cut) return ''
  const frames = cut.frames.toLocaleString()
  if (cut.method === 'encode') return `Exact · all ${frames} frames re-encoded`
  if (cut.frameExact) {
    if (cut.reencodedFrames === 0) return `Exact · all ${frames} frames copied untouched`
    const share = ((cut.reencodedFrames / cut.frames) * 100).toFixed(cut.reencodedFrames / cut.frames < 0.1 ? 1 : 0)
    return `Exact · ${cut.reencodedFrames.toLocaleString()} of ${frames} frames re-encoded (${share}%)`
  }
  const parts: string[] = []
  if (cut.extraFramesBefore > 0) parts.push(`starts ${cut.extraFramesBefore} frames early`)
  if (cut.extraFramesAfter > 0) parts.push(`ends ${cut.extraFramesAfter} frames late`)
  return `Untouched · ${parts.join(', ')}`
}

export function ExportDialog({ project, clips, status, onClose }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<ExportSettings>(project.exportSettings)
  const ordered = useMemo(() => [...clips].sort((a, b) => a.start - b.start), [clips])
  const [chosen, setChosen] = useState(() => new Set(ordered.filter((c) => c.exports.length === 0).map((c) => c.id)))
  const [previews, setPreviews] = useState<Record<string, CutPreview>>({})
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState(false)

  const methods = methodsFor(project.media, project.analysis.packets)
  const method: CutMethod = methods.find((m) => m.method === settings.method)?.method ?? methods.find((m) => m.recommended)!.method
  const codec = method === 'encode' ? ENCODE_PRESETS[settings.encodePreset].codec : project.media.video.codec
  const containers = containersFor(codec)
  const container: Container =
    settings.container && containers.includes(settings.container)
      ? settings.container
      : defaultContainer(project.media, method, settings.encodePreset)

  useEffect(() => {
    let current = true
    void window.api.previewCuts(project.id, method).then((result) => {
      if (current) setPreviews(result)
    })
    return () => {
      current = false
    }
  }, [project.id, method])

  const update = (patch: Partial<ExportSettings>): void => {
    const next = { ...settings, ...patch }
    setSettings(next)
    void window.api.saveExportSettings(project.id, next)
  }

  // A finished batch stays on screen until closed, then the dialog starts fresh.
  const running = status?.projectId === project.id && status.running
  const progress = status?.projectId === project.id && (running || started) ? status : null
  const finished = progress !== null && !running

  const audioNotes = project.media.audio
    .filter((stream) => !supportsAudio(container, stream.codec))
    .map((stream) => {
      const fallback = AUDIO_FALLBACK[container]
      return `${stream.codec} audio can't go in ${container}, so it will be converted to ${fallback.codec}${fallback.lossless ? ' (lossless)' : ' (lossy)'}.`
    })

  const start = async (): Promise<void> => {
    setError(null)
    setStarted(true)
    try {
      await window.api.startExport({
        projectId: project.id,
        clipIds: ordered.filter((clip) => chosen.has(clip.id)).map((clip) => clip.id),
        settings: { ...settings, method, container }
      })
    } catch (reason) {
      setStarted(false)
      setError(reason instanceof Error ? reason.message.replace(/^.*Error: /, '') : String(reason))
    }
  }

  const chooseFolder = async (): Promise<void> => {
    const folder = await window.api.pickFolder(settings.outputDir)
    if (folder) update({ outputDir: folder })
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-label="Export clips">
        <header className="dialog-header">
          <h2>Export clips</h2>
          <button className="close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {progress ? (
          <ExportProgress status={progress} onReveal={(path) => void window.api.reveal(path)} />
        ) : (
          <div className="dialog-body">
            <div className="export-options">
              <fieldset>
                <legend>Method</legend>
                {methods.map((option) => (
                  <label className="choice" key={option.method}>
                    <input
                      type="radio"
                      name="method"
                      checked={method === option.method}
                      onChange={() => update({ method: option.method, container: null })}
                    />
                    <span>
                      <strong>
                        {option.label}
                        {option.recommended ? <em>Recommended</em> : null}
                      </strong>
                      <small>{option.description}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              {method === 'encode' && (
                <div className="field">
                  <label htmlFor="preset">Format</label>
                  <select
                    id="preset"
                    value={settings.encodePreset}
                    onChange={(event) => update({ encodePreset: event.target.value as EncodePreset, container: null })}
                  >
                    {(Object.keys(ENCODE_PRESETS) as EncodePreset[]).map((preset) => (
                      <option key={preset} value={preset}>
                        {ENCODE_PRESETS[preset].label}
                      </option>
                    ))}
                  </select>
                  <p className="field-note">{ENCODE_PRESETS[settings.encodePreset].description}</p>
                </div>
              )}
              <div className="field">
                <label htmlFor="container">Container</label>
                <select
                  id="container"
                  value={container}
                  onChange={(event) => update({ container: event.target.value as Container })}
                >
                  {containers.map((option) => (
                    <option key={option} value={option}>
                      {CONTAINER_LABELS[option]}
                    </option>
                  ))}
                </select>
                {audioNotes.map((note) => (
                  <p className="field-note" key={note}>
                    {note}
                  </p>
                ))}
                {(container === 'avi' || container === 'mpg') && (
                  <p className="field-note">This container stores little metadata, so tags will mostly survive in the filename.</p>
                )}
              </div>
              <div className="field">
                <label>Output folder</label>
                <button className="folder" type="button" onClick={() => void chooseFolder()}>
                  {settings.outputDir ?? 'Choose folder…'}
                </button>
              </div>
              <div className="field">
                <label htmlFor="template">Filename</label>
                <input
                  id="template"
                  value={settings.template}
                  spellCheck={false}
                  onChange={(event) => update({ template: event.target.value })}
                />
                <p className="field-note">
                  {TEMPLATE_TOKENS.map((token) => (
                    <code key={token}>{`{${token}}`}</code>
                  ))}
                </p>
              </div>
            </div>
            <div className="export-clips">
              <div className="export-clips-header">
                <span>
                  {chosen.size} of {ordered.length} clips
                </span>
                <button type="button" onClick={() => setChosen(new Set(ordered.map((clip) => clip.id)))}>
                  All
                </button>
                <button type="button" onClick={() => setChosen(new Set())}>
                  None
                </button>
              </div>
              <ul>
                {ordered.map((clip, index) => (
                  <li key={clip.id}>
                    <label className="export-clip">
                      <input
                        type="checkbox"
                        checked={chosen.has(clip.id)}
                        onChange={(event) => {
                          const next = new Set(chosen)
                          if (event.target.checked) next.add(clip.id)
                          else next.delete(clip.id)
                          setChosen(next)
                        }}
                      />
                      <span>
                        <strong>
                          {renderFilename(settings.template, clip, { projectName: project.name, index: index + 1 })}.
                          {container}
                        </strong>
                        <small>
                          {formatDuration(clip.end - clip.start)} · {describeCut(previews[clip.id])}
                          {clip.exports.length > 0 ? ' · exported before' : ''}
                        </small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {error && <p className="dialog-error">{error}</p>}
        <footer className="dialog-footer">
          {running ? (
            <button onClick={() => void window.api.cancelExport()}>Stop export</button>
          ) : finished ? (
            <button className="primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button onClick={onClose}>Cancel</button>
              <button
                className="primary"
                disabled={chosen.size === 0 || !settings.outputDir}
                onClick={() => void start()}
              >
                Export {chosen.size} clip{chosen.size === 1 ? '' : 's'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

const STATE_LABELS = { pending: 'Waiting', running: '', done: 'Done', failed: 'Failed', cancelled: 'Stopped' }

function ExportProgress({
  status,
  onReveal
}: {
  status: ExportStatus
  onReveal: (path: string) => void
}): React.JSX.Element {
  return (
    <ul className="export-progress" data-testid="export-progress">
      {status.clips.map((clip) => (
        <li key={clip.clipId} className={clip.state}>
          <div className="export-progress-row">
            <span className="export-name">{clip.name}</span>
            {clip.state === 'running' ? (
              <span className="meter">
                <span style={{ width: `${clip.progress * 100}%` }} />
              </span>
            ) : (
              <span className="export-state">{STATE_LABELS[clip.state]}</span>
            )}
            {clip.outputPath && (
              <button type="button" onClick={() => onReveal(clip.outputPath!)}>
                Show in Finder
              </button>
            )}
          </div>
          {clip.error && <p className="dialog-error">{clip.error}</p>}
          {clip.warning && <p className="field-note warn">{clip.warning}</p>}
        </li>
      ))}
    </ul>
  )
}
