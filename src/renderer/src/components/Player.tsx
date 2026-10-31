import { useEffect, useRef, useState } from 'react'
import { formatTimecode } from '../../../shared/timecode'
import type { JobStatus, Project } from '../../../shared/types'
import type { Playback } from '../playback'

interface Props {
  project: Project
  ready: boolean
  job: JobStatus | undefined
  playback: Playback
  pendingIn: number | null
  onMarkIn: () => void
  onMarkOut: () => void
  onPreviousScene: () => void
  onNextScene: () => void
  onHelp: () => void
  onRelink: () => void
}

const STEP_TEXT = {
  index: 'Reading the rip',
  proxy: 'Building a smooth preview',
  filmstrip: 'Generating thumbnails'
}

export function Player(props: Props): React.JSX.Element {
  const { project, ready, job, playback, pendingIn } = props
  const videoRef = useRef<HTMLVideoElement>(null)
  const timecodeRef = useRef<HTMLSpanElement>(null)
  const [playing, setPlaying] = useState(false)
  const fps = project.media.video.fps

  useEffect(() => {
    playback.attach(ready ? videoRef.current : null)
    return () => playback.attach(null)
  }, [playback, ready, project.id])

  useEffect(
    () =>
      playback.subscribe(() => {
        if (timecodeRef.current) timecodeRef.current.textContent = formatTimecode(playback.time, fps)
        setPlaying(playback.playing)
      }),
    [playback, fps]
  )

  return (
    <section className="player">
      <div className="screen">
        {ready ? (
          <video
            ref={videoRef}
            key={project.id}
            src={`media://video/${project.id}`}
            preload="auto"
            onClick={() => playback.togglePlay()}
          />
        ) : (
          <Preparing {...props} job={job} />
        )}
      </div>
      <div className="transport">
        <span className="timecode" ref={timecodeRef} data-testid="timecode">
          {formatTimecode(0, fps)}
        </span>
        <div className="transport-group">
          <button onClick={props.onPreviousScene} title="Previous scene (Shift+N)" disabled={!ready}>
            ⏮
          </button>
          <button onClick={() => playback.step(-1)} title="Back one frame (←)" disabled={!ready}>
            ◀︎
          </button>
          <button className="play" onClick={() => playback.togglePlay()} title="Play or pause (Space)" disabled={!ready}>
            {playing ? '❚❚' : '▶︎'}
          </button>
          <button onClick={() => playback.step(1)} title="Forward one frame (→)" disabled={!ready}>
            ▶︎|
          </button>
          <button onClick={props.onNextScene} title="Next scene (N)" disabled={!ready}>
            ⏭
          </button>
        </div>
        <div className="transport-group">
          <button className={pendingIn !== null ? 'mark armed' : 'mark'} onClick={props.onMarkIn} disabled={!ready}>
            <kbd>I</kbd> Clip start
          </button>
          <button className="mark" onClick={props.onMarkOut} disabled={!ready || pendingIn === null}>
            <kbd>O</kbd> Clip end
          </button>
        </div>
        <span className="transport-hint">
          {pendingIn !== null ? `Recording from ${formatTimecode(pendingIn, fps)}. Press O at the end of the clip.` : ''}
        </span>
        <button className="help-button" onClick={props.onHelp} title="Keyboard shortcuts (?)">
          ?
        </button>
      </div>
    </section>
  )
}

function Preparing({ project, job, onRelink }: Props): React.JSX.Element {
  const { analysis } = project
  if (project.sourceMissing) {
    return (
      <div className="notice">
        <h2>Can't find this rip</h2>
        <p className="path">{project.sourcePath}</p>
        <p>If it's on an external drive, plug it in and reopen the app. If it moved, point to its new location.</p>
        <button className="primary" onClick={onRelink}>
          Locate File…
        </button>
      </div>
    )
  }
  if (analysis.error) {
    return (
      <div className="notice">
        <h2>This rip couldn't be prepared</h2>
        <p className="path">{analysis.error}</p>
      </div>
    )
  }
  const queued = job && job.queued.length > 0 && job.progress === null
  return (
    <div className="notice">
      <h2>{job && !queued ? STEP_TEXT[job.step] : queued ? 'Waiting for another rip' : 'Preparing'}</h2>
      {job?.progress !== null && job?.progress !== undefined && (
        <span className="meter wide">
          <span style={{ width: `${job.progress * 100}%` }} />
        </span>
      )}
      <p>This happens once per rip and runs in the background, so you can work on other rips meanwhile.</p>
    </div>
  )
}
