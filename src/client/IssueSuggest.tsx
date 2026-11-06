/**
 * The issue key field, with what matches it.
 *
 * A Jira key is not something people remember — they remember "that panic
 * ticket" or half the key, "DZ300-19". So the field asks Jira what matches
 * while the reader types, and the answer is a list they can click or arrow
 * through. The exact key still works: the list is an aid, not a gate.
 *
 * The search runs on Jira's issue picker, which matches keys AND summaries —
 * so "panic" finds the ticket whose title mentions it, and the reader never
 * has to know the key at all.
 */
import * as React from 'react'
import { BORDER, FG, FG_FAINT, FG_MUTED, INPUT_BG } from './theme.js'

export interface Suggestion {
  key: string
  summary: string
}

export interface IssueSuggestProps {
  value: string
  onChange: (value: string) => void
  /** The reader chose one suggestion. */
  onPick: (key: string) => void
  /** Look up what the reader typed, unchanged. */
  onSubmit: () => void
  fetchSuggestions: (query: string) => Promise<Suggestion[]>
  placeholder: string
  label: string
  disabled?: boolean
  /** How long to wait after the last keystroke. */
  delayMs?: number
}

/**
 * The suggestions for one query, in the order Jira ranked them.
 *
 * The exact key comes first when it is among them: if the reader typed the
 * whole key, that is what they meant, whatever else matched the text.
 */
function rank(suggestions: Suggestion[], typed: string): Suggestion[] {
  const key = typed.trim().toUpperCase()
  if (key === '') return suggestions
  const exact = suggestions.filter(item => item.key.toUpperCase() === key)
  const rest = suggestions.filter(item => item.key.toUpperCase() !== key)
  return [...exact, ...rest]
}

export function IssueSuggest({
  value,
  onChange,
  onPick,
  onSubmit,
  fetchSuggestions,
  placeholder,
  label,
  disabled,
  delayMs = 220,
}: IssueSuggestProps): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [items, setItems] = React.useState<Suggestion[]>([])
  const [loading, setLoading] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const rootRef = React.useRef<HTMLDivElement>(null)
  // The key the reader just chose. Looking it up again would offer the very
  // row they picked, over the issue they are now reading.
  const pickedRef = React.useRef<string | null>(null)

  // The list follows the text, with a pause so a fast typist makes one call.
  React.useEffect(() => {
    const text = value.trim()
    if (text === '') { setItems([]); setOpen(false); return }
    if (pickedRef.current !== null && pickedRef.current.toUpperCase() === text.toUpperCase()) {
      pickedRef.current = null
      setItems([])
      setOpen(false)
      return
    }
    let alive = true
    setLoading(true)
    const timer = setTimeout(() => {
      fetchSuggestions(text)
        .then(result => {
          if (!alive) return
          setItems(rank(result, text))
          setActive(0)
          setOpen(result.length > 0)
        })
        .catch(() => {
          if (alive) { setItems([]); setOpen(false) }
        })
        .finally(() => { if (alive) setLoading(false) })
    }, delayMs)
    return () => { alive = false; clearTimeout(timer) }
  }, [value, delayMs, fetchSuggestions])

  // A click outside closes the list; the reader's own click on an item is
  // handled before this fires.
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  function pick(key: string): void {
    pickedRef.current = key
    onChange(key)
    setOpen(false)
    onPick(key)
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => { if (items.length > 0) setOpen(true) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' && items.length > 0) {
            e.preventDefault()
            setOpen(true)
            setActive(current => (current + 1) % items.length)
            return
          }
          if (e.key === 'ArrowUp' && items.length > 0) {
            e.preventDefault()
            setOpen(true)
            setActive(current => (current - 1 + items.length) % items.length)
            return
          }
          if (e.key === 'Escape') {
            if (open) { e.preventDefault(); setOpen(false) }
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            const chosen = open ? items[active] : undefined
            if (chosen !== undefined) pick(chosen.key)
            else onSubmit()
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 8px',
          background: INPUT_BG,
          color: FG,
          border: `1px solid ${BORDER}`,
          borderRadius: 4,
          font: 'inherit',
        }}
      />
      {open && items.length > 0 && (
        <ul
          role="listbox"
          style={{
            position: 'absolute',
            zIndex: 20,
            top: '100%',
            left: 0,
            right: 0,
            margin: '2px 0 0',
            padding: 0,
            listStyle: 'none',
            maxHeight: 240,
            overflowY: 'auto',
            // The shell's own menu surface: a translucent fill over a blur.
            // A plain background would let the panel's own text read through
            // the list, which is worse than a slightly frosted surface.
            background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base))',
            backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(8px))',
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            boxShadow: 'var(--dsw-elevation-panel, 0 4px 16px rgba(0,0,0,0.18))',
          }}
        >
          {items.map((item, index) => (
            <li
              key={item.key}
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => setActive(index)}
              onMouseDown={e => { e.preventDefault() }}
              onClick={() => pick(item.key)}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                padding: '6px 10px',
                cursor: 'pointer',
                background: index === active ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06))' : 'transparent',
                fontSize: 13,
              }}
            >
              <span style={{ color: FG, fontWeight: 600, whiteSpace: 'nowrap' }}>{item.key}</span>
              <span style={{ color: FG_MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.summary}
              </span>
            </li>
          ))}
        </ul>
      )}
      {loading && !open && (
        <span style={{ position: 'absolute', right: 8, top: 7, fontSize: 11, color: FG_FAINT }}>…</span>
      )}
    </div>
  )
}
