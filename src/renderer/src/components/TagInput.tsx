import { useId, useState } from 'react'

interface Props {
  label: string
  values: string[]
  suggestions: string[]
  placeholder: string
  onChange: (values: string[]) => void
}

/** Chips for repeating values. Past values across all rips are offered as you type. */
export function TagInput({ label, values, suggestions, placeholder, onChange }: Props): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const listId = useId()

  const add = (raw: string): void => {
    const value = raw.trim()
    setDraft('')
    if (value && !values.includes(value)) onChange([...values, value])
  }

  return (
    <div className="field">
      <label htmlFor={listId + 'input'}>{label}</label>
      <div className="tag-input">
        {values.map((value) => (
          <span className="tag" key={value}>
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((candidate) => candidate !== value))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={listId + 'input'}
          list={listId}
          value={draft}
          placeholder={values.length === 0 ? placeholder : ''}
          onChange={(event) => {
            const text = event.target.value
            if (text.endsWith(',')) add(text.slice(0, -1))
            else setDraft(text)
          }}
          onBlur={() => add(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add(draft)
            } else if (event.key === 'Backspace' && draft === '' && values.length > 0) {
              onChange(values.slice(0, -1))
            }
          }}
        />
        <datalist id={listId}>
          {suggestions
            .filter((suggestion) => !values.includes(suggestion))
            .map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
        </datalist>
      </div>
    </div>
  )
}
