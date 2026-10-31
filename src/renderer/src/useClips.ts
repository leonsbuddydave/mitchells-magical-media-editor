import { useCallback, useEffect, useRef, useState } from 'react'
import type { Clip, Project } from '../../shared/types'

const SAVE_DELAY_MS = 300
const HISTORY_LIMIT = 200
/** Edits with the same key this close together undo as a single step. */
const COALESCE_MS = 800

interface History {
  past: Clip[][]
  future: Clip[][]
  lastKey: string | null
  lastAt: number
}

export interface ClipStore {
  clips: Clip[]
  commit: (next: Clip[], key?: string) => void
  undo: () => void
  redo: () => void
  flush: () => Promise<void>
  mergeExports: (project: Project) => void
}

export function useClips(project: Project): ClipStore {
  const [clips, setClips] = useState(project.clips)
  const latest = useRef(clips)
  const history = useRef<History>({ past: [], future: [], lastKey: null, lastAt: 0 })
  const timer = useRef<number | null>(null)
  const dirty = useRef(false)
  const projectId = project.id

  const write = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    if (!dirty.current) return
    dirty.current = false
    await window.api.saveClips(projectId, latest.current)
  }, [projectId])

  const apply = useCallback(
    (next: Clip[]) => {
      latest.current = next
      setClips(next)
      dirty.current = true
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void write(), SAVE_DELAY_MS)
    },
    [write]
  )

  const commit = useCallback(
    (next: Clip[], key?: string) => {
      const record = history.current
      const now = Date.now()
      const coalesce = key !== undefined && key === record.lastKey && now - record.lastAt < COALESCE_MS
      if (!coalesce) {
        record.past.push(latest.current)
        if (record.past.length > HISTORY_LIMIT) record.past.shift()
      }
      record.future = []
      record.lastKey = key ?? null
      record.lastAt = now
      apply(next)
    },
    [apply]
  )

  const undo = useCallback(() => {
    const record = history.current
    const previous = record.past.pop()
    if (!previous) return
    record.future.push(latest.current)
    record.lastKey = null
    apply(previous)
  }, [apply])

  const redo = useCallback(() => {
    const record = history.current
    const next = record.future.pop()
    if (!next) return
    record.past.push(latest.current)
    record.lastKey = null
    apply(next)
  }, [apply])

  /** Export history comes from the main process and is not an undoable edit. */
  const mergeExports = useCallback((updated: Project) => {
    const merged = latest.current.map((clip) => {
      const server = updated.clips.find((candidate) => candidate.id === clip.id)
      return server ? { ...clip, exports: server.exports } : clip
    })
    latest.current = merged
    setClips(merged)
  }, [])

  useEffect(() => {
    const flushOnClose = (): void => void write()
    window.addEventListener('beforeunload', flushOnClose)
    return () => {
      window.removeEventListener('beforeunload', flushOnClose)
      void write()
    }
  }, [write])

  return { clips, commit, undo, redo, flush: write, mergeExports }
}
