const GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'Playback',
    keys: [
      ['Space or K', 'Play or pause'],
      ['J / L', 'Shuttle back or forward; press again to go faster'],
      ['← / →', 'One frame'],
      ['Shift + ← / →', 'One second'],
      ['↑ / ↓', 'Ten seconds'],
      ['N / Shift + N', 'Next or previous scene']
    ]
  },
  {
    title: 'Marking',
    keys: [
      ['I', 'Start a clip here'],
      ['O', 'End the clip here'],
      ['[ / ]', 'Move the selected clip’s start or end here'],
      ['Esc', 'Cancel marking, or deselect'],
      ['Enter', 'Edit the selected clip’s title'],
      ['Delete', 'Delete the selected clip'],
      ['⌘Z / ⇧⌘Z', 'Undo or redo']
    ]
  },
  {
    title: 'Timeline',
    keys: [
      ['= / -', 'Zoom in or out'],
      ['0', 'Show the whole rip'],
      ['⌘ + scroll or pinch', 'Zoom at the pointer'],
      ['Scroll or Alt + drag', 'Pan'],
      ['Shift while trimming', 'Turn off scene snapping'],
      ['E', 'Export']
    ]
  }
]

export function Shortcuts({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog shortcuts" role="dialog" aria-label="Keyboard shortcuts">
        <header className="dialog-header">
          <h2>Keyboard shortcuts</h2>
          <button className="close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="shortcut-groups">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.keys.map(([keys, action]) => (
                  <div key={keys}>
                    <dt>{keys}</dt>
                    <dd>{action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
