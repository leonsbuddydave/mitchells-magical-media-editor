import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import { formatDuration } from '../../../shared/timecode'
import type { Clip, Project } from '../../../shared/types'
import type { Playback } from '../playback'
import { clipColor } from '../colors'

export interface TimelineHandle {
  zoom: (factor: number) => void
  fit: () => void
}

interface Props {
  project: Project
  clips: Clip[]
  selectedId: string | null
  pendingIn: number | null
  playback: Playback
  onSelect: (id: string | null) => void
  onTrim: (id: string, start: number, end: number) => void
}

const RULER_HEIGHT = 22
const STRIP_HEIGHT = 58
const LANES_TOP = RULER_HEIGHT + STRIP_HEIGHT + 6
const MAX_LANE_HEIGHT = 30
const EDGE_GRAB_PX = 7
const SNAP_PX = 7
const KEYFRAME_MIN_PX_PER_SECOND = 12
const MAX_PX_PER_SECOND = 400
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

const COLORS = {
  background: '#101215',
  ruler: '#1a1d22',
  tick: '#3a4049',
  label: '#8b93a0',
  scene: '#e8b34c',
  keyframe: '#5b6573',
  playhead: '#ff5a4f',
  pending: 'rgba(232, 179, 76, 0.28)',
  pendingEdge: '#e8b34c'
}

type Drag =
  | { kind: 'scrub' }
  | { kind: 'pan'; startX: number; startView: number }
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; fixed: number }

interface Lane {
  clip: Clip
  lane: number
}

/** Overlapping clips go on separate rows so every clip stays reachable. */
function assignLanes(clips: Clip[]): { lanes: Lane[]; count: number } {
  const ends: number[] = []
  const lanes = [...clips]
    .sort((a, b) => a.start - b.start)
    .map((clip) => {
      let lane = ends.findIndex((end) => end <= clip.start)
      if (lane === -1) lane = ends.length
      ends[lane] = clip.end
      return { clip, lane }
    })
  return { lanes, count: Math.max(1, ends.length) }
}

export const Timeline = forwardRef<TimelineHandle, Props>(function Timeline(props, handle) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  const view = useRef({ start: 0, pxPerSecond: 1, width: 0, height: 0 })
  const sheets = useRef(new Map<number, HTMLImageElement>())
  const frame = useRef(0)
  const drag = useRef<Drag | null>(null)

  const duration = (): number => propsRef.current.playback.duration

  const clampView = (): void => {
    const v = view.current
    const span = v.width / v.pxPerSecond
    v.start = Math.max(0, Math.min(v.start, Math.max(0, duration() - span)))
  }

  const fit = (): void => {
    const v = view.current
    v.pxPerSecond = v.width > 0 && duration() > 0 ? v.width / duration() : 1
    v.start = 0
  }

  const sheetImage = (index: number): HTMLImageElement | null => {
    const existing = sheets.current.get(index)
    if (existing) return existing.complete && existing.naturalWidth > 0 ? existing : null
    const image = new Image()
    image.src = `media://filmstrip/${propsRef.current.project.id}/sheet-${String(index + 1).padStart(4, '0')}.jpg`
    image.onload = () => schedule()
    sheets.current.set(index, image)
    return null
  }

  const draw = (): void => {
    frame.current = 0
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const v = view.current
    const { project, clips, selectedId, pendingIn, playback } = propsRef.current
    const scale = window.devicePixelRatio || 1
    context.setTransform(scale, 0, 0, scale, 0, 0)
    context.fillStyle = COLORS.background
    context.fillRect(0, 0, v.width, v.height)

    const toX = (time: number): number => (time - v.start) * v.pxPerSecond
    const end = v.start + v.width / v.pxPerSecond

    // Filmstrip
    const strip = project.analysis.filmstrip
    if (strip) {
      const tileWidth = (STRIP_HEIGHT * strip.thumbWidth) / strip.thumbHeight
      const perSheet = strip.columns * strip.rows
      const tileSeconds = tileWidth / v.pxPerSecond
      const first = Math.floor(v.start / tileSeconds)
      for (let tile = first; tile * tileSeconds < end; tile += 1) {
        const time = tile * tileSeconds
        const thumb = Math.min(strip.count - 1, Math.floor(time / strip.interval))
        const image = sheetImage(Math.floor(thumb / perSheet))
        const x = toX(time)
        if (!image) continue
        const inSheet = thumb % perSheet
        context.drawImage(
          image,
          (inSheet % strip.columns) * strip.thumbWidth,
          Math.floor(inSheet / strip.columns) * strip.thumbHeight,
          strip.thumbWidth,
          strip.thumbHeight,
          x,
          RULER_HEIGHT,
          tileWidth,
          STRIP_HEIGHT
        )
      }
    }

    // Ruler
    context.fillStyle = COLORS.ruler
    context.fillRect(0, 0, v.width, RULER_HEIGHT)
    const step = TICK_STEPS.find((candidate) => candidate * v.pxPerSecond >= 90) ?? 7200
    context.font = '11px -apple-system, system-ui, sans-serif'
    context.textBaseline = 'middle'
    for (let tick = Math.floor(v.start / step) * step; tick < end; tick += step) {
      const x = Math.round(toX(tick)) + 0.5
      context.fillStyle = COLORS.tick
      context.fillRect(x, 14, 1, RULER_HEIGHT - 14)
      context.fillStyle = COLORS.label
      context.fillText(formatDuration(tick), x + 4, 8)
    }

    // Keyframes only matter, and only fit, when zoomed in on long-GOP footage.
    const packets = project.analysis.packets
    if (packets && !packets.intraOnly && v.pxPerSecond >= KEYFRAME_MIN_PX_PER_SECOND) {
      context.fillStyle = COLORS.keyframe
      for (const time of packets.keyframes) {
        if (time < v.start || time > end) continue
        context.fillRect(Math.round(toX(time)), RULER_HEIGHT - 5, 1, 5)
      }
    }

    // Scene markers
    context.fillStyle = COLORS.scene
    for (const time of project.analysis.scenes) {
      if (time < v.start || time > end) continue
      const x = toX(time)
      context.beginPath()
      context.moveTo(x - 3, 0)
      context.lineTo(x + 3, 0)
      context.lineTo(x, 6)
      context.closePath()
      context.fill()
    }

    // Clips
    const { lanes, count } = assignLanes(clips)
    const laneHeight = Math.min(MAX_LANE_HEIGHT, (v.height - LANES_TOP - 4) / count)
    const ordered = [...clips].sort((a, b) => a.start - b.start)
    for (const { clip, lane } of lanes) {
      const x = toX(clip.start)
      const width = Math.max(2, (clip.end - clip.start) * v.pxPerSecond)
      if (x > v.width || x + width < 0) continue
      const y = LANES_TOP + lane * laneHeight
      const color = clipColor(ordered.indexOf(clip))
      const selected = clip.id === selectedId
      context.fillStyle = color
      context.globalAlpha = selected ? 1 : 0.72
      context.beginPath()
      context.roundRect(x, y, width, laneHeight - 3, 3)
      context.fill()
      context.globalAlpha = 1
      if (selected) {
        context.strokeStyle = '#ffffff'
        context.lineWidth = 1.5
        context.stroke()
      }
      if (width > 30) {
        context.save()
        context.beginPath()
        context.rect(x + 2, y, width - 4, laneHeight - 3)
        context.clip()
        context.fillStyle = '#0d0f12'
        context.font = '600 11px -apple-system, system-ui, sans-serif'
        context.fillText(clip.title || 'Untitled', Math.max(x + 6, 6), y + (laneHeight - 3) / 2)
        context.restore()
      }
    }

    // Clip being marked
    if (pendingIn !== null) {
      const from = toX(Math.min(pendingIn, playback.time))
      const to = toX(Math.max(pendingIn, playback.time))
      context.fillStyle = COLORS.pending
      context.fillRect(from, RULER_HEIGHT, Math.max(1, to - from), v.height - RULER_HEIGHT)
      context.fillStyle = COLORS.pendingEdge
      context.fillRect(toX(pendingIn) - 1, 0, 2, v.height)
    }

    // Playhead
    const headX = toX(playback.time)
    context.fillStyle = COLORS.playhead
    context.fillRect(Math.round(headX) - 1, 0, 2, v.height)
    context.beginPath()
    context.moveTo(headX - 6, 0)
    context.lineTo(headX + 6, 0)
    context.lineTo(headX, 8)
    context.closePath()
    context.fill()
  }

  const schedule = (): void => {
    if (!frame.current) frame.current = requestAnimationFrame(draw)
  }

  const zoomAround = useCallback((factor: number, anchorX: number): void => {
    const v = view.current
    const minimum = v.width / Math.max(duration(), 1)
    const next = Math.min(MAX_PX_PER_SECOND, Math.max(minimum, v.pxPerSecond * factor))
    const anchorTime = v.start + anchorX / v.pxPerSecond
    v.pxPerSecond = next
    v.start = anchorTime - anchorX / next
    clampView()
    schedule()
  }, [])

  useImperativeHandle(handle, () => ({
    zoom: (factor) => {
      const v = view.current
      const head = (propsRef.current.playback.time - v.start) * v.pxPerSecond
      zoomAround(factor, Math.max(0, Math.min(v.width, head)))
    },
    fit: () => {
      fit()
      schedule()
    }
  }))

  // Size the canvas to its box, at device resolution.
  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const observer = new ResizeObserver(() => {
      const v = view.current
      const wasFitted = v.width === 0 || Math.abs(v.pxPerSecond - v.width / Math.max(duration(), 1)) < 1e-6
      v.width = wrap.clientWidth
      v.height = wrap.clientHeight
      const scale = window.devicePixelRatio || 1
      canvas.width = v.width * scale
      canvas.height = v.height * scale
      if (wasFitted) fit()
      clampView()
      schedule()
    })
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    sheets.current.clear()
    fit()
    schedule()
  }, [props.project.id, props.playback.duration])

  useEffect(schedule, [props.clips, props.selectedId, props.pendingIn, props.project.analysis])

  useEffect(
    () =>
      props.playback.subscribe(() => {
        const v = view.current
        const { playback } = propsRef.current
        const span = v.width / v.pxPerSecond
        // Page along with the playhead rather than scrolling under the mouse.
        if (!drag.current && (playback.time < v.start || playback.time > v.start + span)) {
          v.start = playback.time - span * 0.1
          clampView()
        }
        schedule()
      }),
    [props.playback]
  )

  const eventX = (event: { clientX: number }): number => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return event.clientX - rect.left
  }

  const timeAt = (x: number): number => view.current.start + x / view.current.pxPerSecond

  const hitClip = (x: number, y: number): { clip: Clip; edge: 'start' | 'end' | null } | null => {
    const v = view.current
    const { clips } = propsRef.current
    const { lanes, count } = assignLanes(clips)
    const laneHeight = Math.min(MAX_LANE_HEIGHT, (v.height - LANES_TOP - 4) / count)
    for (const { clip, lane } of lanes) {
      const top = LANES_TOP + lane * laneHeight
      if (y < top || y > top + laneHeight) continue
      const left = (clip.start - v.start) * v.pxPerSecond
      const right = (clip.end - v.start) * v.pxPerSecond
      if (x < left - EDGE_GRAB_PX || x > right + EDGE_GRAB_PX) continue
      if (Math.abs(x - left) <= EDGE_GRAB_PX) return { clip, edge: 'start' }
      if (Math.abs(x - right) <= EDGE_GRAB_PX) return { clip, edge: 'end' }
      return { clip, edge: null }
    }
    return null
  }

  const snapTime = (x: number, bypass: boolean): number => {
    const { playback, project } = propsRef.current
    const time = timeAt(x)
    if (bypass) return playback.snap(time)
    const reach = SNAP_PX / view.current.pxPerSecond
    const near = project.analysis.scenes.find((scene) => Math.abs(scene - time) <= reach)
    return playback.snap(near ?? time)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    canvasRef.current!.setPointerCapture(event.pointerId)
    const x = eventX(event)
    const y = event.clientY - canvasRef.current!.getBoundingClientRect().top
    const { playback, onSelect } = propsRef.current
    const hit = y >= LANES_TOP ? hitClip(x, y) : null
    if (hit) {
      onSelect(hit.clip.id)
      if (hit.edge) {
        drag.current = {
          kind: 'trim',
          id: hit.clip.id,
          edge: hit.edge,
          fixed: hit.edge === 'start' ? hit.clip.end : hit.clip.start
        }
      }
      return
    }
    if (event.altKey || event.button === 1) {
      drag.current = { kind: 'pan', startX: x, startView: view.current.start }
      return
    }
    if (y >= LANES_TOP) onSelect(null)
    drag.current = { kind: 'scrub' }
    playback.halt()
    playback.seek(timeAt(x))
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const x = eventX(event)
    const active = drag.current
    if (!active) {
      const y = event.clientY - canvasRef.current!.getBoundingClientRect().top
      const hit = y >= LANES_TOP ? hitClip(x, y) : null
      canvasRef.current!.style.cursor = hit?.edge ? 'ew-resize' : hit ? 'pointer' : 'text'
      return
    }
    const { playback, onTrim } = propsRef.current
    if (active.kind === 'scrub') playback.seek(timeAt(x))
    else if (active.kind === 'pan') {
      view.current.start = active.startView - (x - active.startX) / view.current.pxPerSecond
      clampView()
      schedule()
    } else {
      const time = snapTime(x, event.shiftKey)
      const minimum = 1 / playback.fps
      if (active.edge === 'start') onTrim(active.id, Math.min(time, active.fixed - minimum), active.fixed)
      else onTrim(active.id, active.fixed, Math.max(time, active.fixed + minimum))
      playback.seek(time)
    }
  }

  const onPointerUp = (): void => {
    drag.current = null
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        zoomAround(Math.exp(-event.deltaY * 0.01), eventX(event))
        return
      }
      const v = view.current
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      v.start += delta / v.pxPerSecond
      clampView()
      schedule()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [zoomAround])

  return (
    <div className="timeline" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        data-testid="timeline"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  )
})
