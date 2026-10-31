import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { DEFAULT_TEMPLATE } from '../shared/filename'
import type { Clip, KnownPlace, Project, ProjectSummary, Suggestions } from '../shared/types'
import { probeMedia } from './probe'

const CLIP_DEFAULTS: Pick<Clip, 'time' | 'timeZone' | 'place'> = { time: '', timeZone: '', place: null }

/** One folder per rip, holding its project file and any generated media. */
export class Store {
  private readonly projects = new Map<string, Project>()
  private readonly saves = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  dir(id: string): string {
    return join(this.root, id)
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const project = JSON.parse(await readFile(join(this.root, entry.name, 'project.json'), 'utf8')) as Project
        project.sourceMissing = !existsSync(project.sourcePath)
        // Clips saved before times and places existed.
        project.clips = project.clips.map((clip) => ({ ...CLIP_DEFAULTS, ...clip }))
        this.projects.set(project.id, project)
      } catch (error) {
        console.error(`Skipping unreadable project ${entry.name}:`, error)
      }
    }
  }

  all(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }

  get(id: string): Project {
    const project = this.projects.get(id)
    if (!project) throw new Error('That project no longer exists.')
    return project
  }

  has(id: string): boolean {
    return this.projects.has(id)
  }

  findBySource(path: string): Project | undefined {
    return this.all().find((project) => project.sourcePath === path)
  }

  async create(sourcePath: string): Promise<Project> {
    const media = await probeMedia(sourcePath)
    const now = new Date().toISOString()
    const previousOutput = this.all()
      .filter((project) => project.exportSettings.outputDir)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    const project: Project = {
      id: randomUUID(),
      name: basename(sourcePath, extname(sourcePath)),
      createdAt: now,
      updatedAt: now,
      sourcePath,
      sourceMissing: false,
      media,
      analysis: { packets: null, needsProxy: null, proxyReady: false, filmstrip: null, scenes: [], error: null },
      clips: [],
      exportSettings: {
        outputDir: previousOutput?.exportSettings.outputDir ?? null,
        container: null,
        method: null,
        encodePreset: 'ffv1',
        template: DEFAULT_TEMPLATE
      }
    }
    await mkdir(this.dir(project.id), { recursive: true })
    this.projects.set(project.id, project)
    await this.save(project)
    return project
  }

  /** Writes are atomic and serialized per project, so a crash cannot lose the file. */
  save(project: Project): Promise<void> {
    project.updatedAt = new Date().toISOString()
    const write = async (): Promise<void> => {
      if (!this.projects.has(project.id)) return
      const path = join(this.dir(project.id), 'project.json')
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(project, null, 2))
      await rename(temporary, path)
    }
    const next = (this.saves.get(project.id) ?? Promise.resolve()).then(write, write)
    this.saves.set(project.id, next)
    return next
  }

  /** Removes the app's own data for a rip. The rip itself is never touched. */
  async delete(id: string): Promise<void> {
    await this.saves.get(id)
    this.projects.delete(id)
    await rm(this.dir(id), { recursive: true, force: true })
  }

  summaries(): ProjectSummary[] {
    return this.all().map((project) => ({
      id: project.id,
      name: project.name,
      sourcePath: project.sourcePath,
      sourceMissing: project.sourceMissing,
      duration: project.media.duration,
      clipCount: project.clips.length,
      exportedCount: project.clips.filter((clip) => clip.exports.length > 0).length,
      ready: isReady(project),
      updatedAt: project.updatedAt
    }))
  }

  suggestions(): Suggestions {
    const people = new Map<string, number>()
    const locations = new Map<string, number>()
    const tags = new Map<string, number>()
    const count = (map: Map<string, number>, value: string): void => {
      if (value.trim()) map.set(value, (map.get(value) ?? 0) + 1)
    }
    for (const project of this.projects.values()) {
      for (const clip of project.clips) {
        clip.people.forEach((value) => count(people, value))
        clip.tags.forEach((value) => count(tags, value))
        count(locations, clip.location)
      }
    }
    const places = new Map<string, KnownPlace>()
    for (const project of this.projects.values()) {
      for (const clip of project.clips) {
        if (clip.place) places.set(clip.location.trim().toLowerCase(), { label: clip.location, place: clip.place })
      }
    }
    return { people: byUse(people), locations: byUse(locations), tags: byUse(tags), places: [...places.values()] }
  }
}

function byUse(counts: Map<string, number>): string[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value)
}

export function isReady(project: Project): boolean {
  const { analysis } = project
  return analysis.packets !== null && (analysis.needsProxy === false || analysis.proxyReady)
}
