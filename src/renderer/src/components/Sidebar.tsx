import type { JobStatus, ProjectSummary } from '../../../shared/types'
import { formatDuration } from '../../../shared/timecode'

interface Props {
  projects: ProjectSummary[]
  jobs: JobStatus[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onDelete: (id: string) => void
}

const STEP_LABELS = { index: 'Indexing', proxy: 'Building preview', filmstrip: 'Finding scenes' }

export function Sidebar({ projects, jobs, selectedId, onSelect, onAdd, onDelete }: Props): React.JSX.Element {
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1>Rips</h1>
        <button className="add-button" onClick={onAdd} title="Add one or more rips">
          + Add
        </button>
      </header>
      <ul className="project-list">
        {projects.map((project) => {
          const job = jobs.find((candidate) => candidate.projectId === project.id)
          const running = job !== undefined && job.queued.length === 0
          return (
            <li key={project.id}>
              <button
                className={`project-row${project.id === selectedId ? ' selected' : ''}`}
                onClick={() => onSelect(project.id)}
              >
                <span className="project-name">{project.name}</span>
                <span className="project-meta">
                  {project.sourceMissing
                    ? 'Source file missing'
                    : `${formatDuration(project.duration)} · ${clipSummary(project)}`}
                </span>
                {job && (
                  <span className="project-job">
                    <span>
                      {STEP_LABELS[job.step]}
                      {!running && job.progress === null ? ' (queued)' : ''}
                    </span>
                    {job.progress !== null && (
                      <span className="meter">
                        <span style={{ width: `${job.progress * 100}%` }} />
                      </span>
                    )}
                  </span>
                )}
              </button>
              <button
                className="project-remove"
                title={`Remove ${project.name} (the rip itself is kept)`}
                aria-label={`Remove ${project.name}`}
                onClick={() => onDelete(project.id)}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function clipSummary(project: ProjectSummary): string {
  if (project.clipCount === 0) return 'no clips'
  const clips = `${project.clipCount} clip${project.clipCount === 1 ? '' : 's'}`
  return project.exportedCount > 0 ? `${clips}, ${project.exportedCount} exported` : clips
}
