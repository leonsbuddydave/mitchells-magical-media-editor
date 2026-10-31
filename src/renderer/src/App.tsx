import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, ExportStatus, JobStatus, Project, ProjectSummary, Suggestions } from '../../shared/types'
import { formatDuration } from '../../shared/timecode'
import { ClipPanel, type ClipPanelHandle } from './components/ClipPanel'
import { ExportDialog } from './components/ExportDialog'
import { Player } from './components/Player'
import { Shortcuts } from './components/Shortcuts'
import { Sidebar } from './components/Sidebar'
import { Timeline, type TimelineHandle } from './components/Timeline'
import { Playback } from './playback'
import { useClips } from './useClips'

const NO_SUGGESTIONS: Suggestions = { people: [], locations: [], tags: [], places: [] }

export function App(): React.JSX.Element {
  const [setupError, setSetupError] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [jobs, setJobs] = useState<JobStatus[]>([])
  const [suggestions, setSuggestions] = useState(NO_SUGGESTIONS)
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null)
  const [addErrors, setAddErrors] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void window.api.setupError().then(setSetupError)
    void window.api.listProjects().then((list) => {
      setProjects(list)
      setSelectedId((current) => current ?? list[0]?.id ?? null)
    })
    void window.api.jobs().then(setJobs)
    void window.api.suggestions().then(setSuggestions)
    void window.api.exportStatus().then(setExportStatus)
    const subscriptions = [
      window.api.onProjects(setProjects),
      window.api.onJobs(setJobs),
      window.api.onSuggestions(setSuggestions),
      window.api.onExport(setExportStatus)
    ]
    return () => subscriptions.forEach((unsubscribe) => unsubscribe())
  }, [])

  useEffect(() => {
    if (!selectedId && projects.length > 0) setSelectedId(projects[0].id)
  }, [projects, selectedId])

  useEffect(() => {
    if (!selectedId) {
      setProject(null)
      return
    }
    let current = true
    void window.api.getProject(selectedId).then((loaded) => {
      if (current) setProject(loaded)
    })
    return () => {
      current = false
    }
  }, [selectedId])

  const addResult = useCallback((result: { added: Project[]; errors: string[] }) => {
    setAddErrors(result.errors)
    if (result.added.length > 0) setSelectedId(result.added[result.added.length - 1].id)
  }, [])

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setDragging(false)
    const paths = Array.from(event.dataTransfer.files).map((file) => window.api.pathForFile(file))
    if (paths.length > 0) void window.api.addPaths(paths).then(addResult)
  }

  const removeProject = async (id: string): Promise<void> => {
    if (!(await window.api.deleteProject(id))) return
    if (id === selectedId) setSelectedId(projects.find((candidate) => candidate.id !== id)?.id ?? null)
  }

  if (setupError) {
    return (
      <div className="fatal">
        <h1>ffmpeg is needed</h1>
        <p>{setupError}</p>
      </div>
    )
  }

  return (
    <div
      className="app"
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget === null) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <Sidebar
        projects={projects}
        jobs={jobs}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onAdd={() => void window.api.addRips().then(addResult)}
        onDelete={(id) => void removeProject(id)}
      />
      {project ? (
        <Workspace
          key={project.id}
          initial={project}
          job={jobs.find((job) => job.projectId === project.id)}
          suggestions={suggestions}
          exportStatus={exportStatus}
        />
      ) : (
        <main className="welcome">
          <h2>Drop your tape rips here</h2>
          <p>Each rip becomes its own project. Nothing is ever changed in the original file.</p>
          <button className="primary" onClick={() => void window.api.addRips().then(addResult)}>
            Add Rips…
          </button>
        </main>
      )}
      {addErrors.length > 0 && (
        <div className="toast" role="alert">
          <strong>Some files couldn't be added</strong>
          {addErrors.map((error) => (
            <p key={error}>{error}</p>
          ))}
          <button onClick={() => setAddErrors([])}>Dismiss</button>
        </div>
      )}
      {dragging && <div className="drop-overlay">Drop to add rips</div>}
    </div>
  )
}

interface WorkspaceProps {
  initial: Project
  job: JobStatus | undefined
  suggestions: Suggestions
  exportStatus: ExportStatus | null
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('.place-matches') !== null
}

function mediaSummary(project: Project): string {
  const { video } = project.media
  const parts = [
    `${video.codec.toUpperCase()}`,
    `${video.width}×${video.height}`,
    `${Math.round(video.fps * 100) / 100} fps`,
    video.fieldOrder && video.fieldOrder !== 'progressive' ? 'interlaced' : null,
    project.analysis.packets ? (project.analysis.packets.intraOnly ? 'cuts on any frame' : 'long-GOP') : null,
    formatDuration(project.media.duration)
  ]
  return parts.filter(Boolean).join(' · ')
}

function Workspace({ initial, job, suggestions, exportStatus }: WorkspaceProps): React.JSX.Element {
  const [project, setProject] = useState(initial)
  const { clips, commit, undo, redo, flush, mergeExports } = useClips(initial)
  const [selectedClip, setSelectedClip] = useState<string | null>(null)
  const [pendingIn, setPendingIn] = useState<number | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [name, setName] = useState(initial.name)
  const playback = useMemo(() => new Playback(), [])
  const timeline = useRef<TimelineHandle>(null)
  const panel = useRef<ClipPanelHandle>(null)

  const { analysis, media } = project
  const ready = analysis.packets !== null && analysis.needsProxy !== null && (!analysis.needsProxy || analysis.proxyReady)
  const frameCount = analysis.packets?.frameCount
  playback.configure(media.video.fps, frameCount ? frameCount / media.video.fps : media.duration)

  useEffect(
    () =>
      window.api.onProject((updated) => {
        if (updated.id !== initial.id) return
        setProject(updated)
        mergeExports(updated)
      }),
    [initial.id, mergeExports]
  )

  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      // A focused button would swallow Space and the other transport keys.
      if (event.target instanceof HTMLElement) event.target.closest('button')?.blur()
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [])

  const patchClip = useCallback(
    (id: string, patch: Partial<Clip>, key?: string) => {
      commit(clips.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip)), key)
    },
    [clips, commit]
  )

  const addClip = useCallback(
    (a: number, b: number) => {
      const clip: Clip = {
        id: crypto.randomUUID(),
        start: Math.min(a, b),
        end: Math.max(a, b),
        title: '',
        date: '',
        time: '',
        timeZone: '',
        people: [],
        location: '',
        place: null,
        tags: [],
        notes: '',
        exports: []
      }
      commit([...clips, clip])
      setSelectedClip(clip.id)
    },
    [clips, commit]
  )

  const deleteClip = useCallback(
    (id: string) => {
      commit(clips.filter((clip) => clip.id !== id))
      setSelectedClip(null)
    },
    [clips, commit]
  )

  const copyPrevious = (id: string): void => {
    const ordered = [...clips].sort((a, b) => a.start - b.start)
    const previous = ordered[ordered.findIndex((clip) => clip.id === id) - 1]
    if (!previous) return
    const { date, location, place, timeZone, people, tags } = previous
    patchClip(id, { date, location, place, timeZone, people, tags })
  }

  const markIn = useCallback(() => setPendingIn(playback.time), [playback])

  const markOut = useCallback(() => {
    if (pendingIn === null) return
    const end = playback.time
    if (end === pendingIn) return
    addClip(pendingIn, end)
    setPendingIn(null)
  }, [addClip, pendingIn, playback])

  const jumpScene = useCallback(
    (direction: 1 | -1) => {
      const { scenes } = analysis
      const now = playback.time
      const margin = 0.5 / playback.fps
      const target =
        direction > 0
          ? scenes.find((scene) => scene > now + margin)
          : ([...scenes].reverse().find((scene) => scene < now - margin) ?? 0)
      if (target !== undefined) {
        playback.halt()
        playback.seek(target)
      }
    },
    [analysis, playback]
  )

  const openExport = useCallback(async () => {
    await flush()
    playback.halt()
    setProject(await window.api.getProject(initial.id))
    setShowExport(true)
  }, [flush, initial.id, playback])

  useEffect(() => {
    if (!ready) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (showExport) return
      if (showHelp) {
        if (event.key === 'Escape' || event.key === '?') setShowHelp(false)
        return
      }
      if (isTyping(event.target)) {
        if (event.key === 'Escape') (event.target as HTMLElement).blur()
        return
      }
      const command = event.metaKey || event.ctrlKey
      if (command) {
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault()
          if (event.shiftKey) redo()
          else undo()
        }
        return
      }
      const stride = event.shiftKey ? 1 : 0
      const handled = ((): boolean => {
        switch (event.key) {
          case ' ':
          case 'k':
          case 'K':
            playback.togglePlay()
            return true
          case 'j':
          case 'J':
            playback.shuttle(-1)
            return true
          case 'l':
          case 'L':
            playback.shuttle(1)
            return true
          case 'ArrowLeft':
            if (stride) playback.jump(-1)
            else playback.step(-1)
            return true
          case 'ArrowRight':
            if (stride) playback.jump(1)
            else playback.step(1)
            return true
          case 'ArrowUp':
            playback.jump(10)
            return true
          case 'ArrowDown':
            playback.jump(-10)
            return true
          case 'i':
          case 'I':
            markIn()
            return true
          case 'o':
          case 'O':
            markOut()
            return true
          case 'n':
            jumpScene(1)
            return true
          case 'N':
            jumpScene(-1)
            return true
          case '[':
          case ']': {
            const clip = clips.find((candidate) => candidate.id === selectedClip)
            if (!clip) return true
            const minimum = 1 / playback.fps
            if (event.key === '[') patchClip(clip.id, { start: Math.min(playback.time, clip.end - minimum) })
            else patchClip(clip.id, { end: Math.max(playback.time, clip.start + minimum) })
            return true
          }
          case 'Escape':
            if (pendingIn !== null) setPendingIn(null)
            else setSelectedClip(null)
            return true
          case 'Enter':
            if (selectedClip) panel.current?.focusTitle()
            return true
          case 'Delete':
          case 'Backspace':
            if (selectedClip) deleteClip(selectedClip)
            return true
          case '=':
          case '+':
            timeline.current?.zoom(1.5)
            return true
          case '-':
            timeline.current?.zoom(1 / 1.5)
            return true
          case '0':
            timeline.current?.fit()
            return true
          case 'e':
          case 'E':
            void openExport()
            return true
          case '?':
            setShowHelp(true)
            return true
          default:
            return false
        }
      })()
      if (handled) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    ready, showExport, showHelp, playback, clips, selectedClip, pendingIn,
    undo, redo, markIn, markOut, jumpScene, patchClip, deleteClip, openExport
  ])

  return (
    <main className="workspace">
      <header className="workspace-header">
        <input
          className="project-title"
          aria-label="Project name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => void window.api.renameProject(project.id, name)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <span className="media-summary">{mediaSummary(project)}</span>
        <button
          className="primary"
          disabled={!analysis.packets || clips.length === 0 || project.sourceMissing}
          onClick={() => void openExport()}
          title="Export (E)"
        >
          Export…
        </button>
      </header>
      <div className="stage">
        <Player
          project={project}
          ready={ready && !project.sourceMissing}
          job={job}
          playback={playback}
          pendingIn={pendingIn}
          onMarkIn={markIn}
          onMarkOut={markOut}
          onPreviousScene={() => jumpScene(-1)}
          onNextScene={() => jumpScene(1)}
          onHelp={() => setShowHelp(true)}
          onRelink={() => void window.api.relinkProject(project.id).then(setProject)}
        />
        <ClipPanel
          ref={panel}
          project={project}
          clips={clips}
          selectedId={selectedClip}
          suggestions={suggestions}
          onSelect={(id) => {
            setSelectedClip(id)
            const clip = clips.find((candidate) => candidate.id === id)
            if (clip) {
              playback.halt()
              playback.seek(clip.start)
            }
          }}
          onChange={patchClip}
          onDelete={deleteClip}
          onCopyPrevious={copyPrevious}
        />
      </div>
      <Timeline
        ref={timeline}
        project={project}
        clips={clips}
        selectedId={selectedClip}
        pendingIn={pendingIn}
        playback={playback}
        onSelect={setSelectedClip}
        onTrim={(id, start, end) => patchClip(id, { start, end }, `trim:${id}`)}
      />
      {showExport && (
        <ExportDialog project={project} clips={clips} status={exportStatus} onClose={() => setShowExport(false)} />
      )}
      {showHelp && <Shortcuts onClose={() => setShowHelp(false)} />}
    </main>
  )
}
