/**
 * The bound ticket, shown in the strip under the composer.
 *
 * A session's Jira binding is the one fact the reader needs before typing:
 * which ticket the work is going to. The conversation's own panel is a tab
 * away, and the command line is a memory away, so the chip puts it where the
 * eye already is.
 *
 * It shows nothing when the session is not bound: an empty chip would be
 * noise, and the neighbour pills do the same.
 */
import * as React from 'react'
import { JiraLogo } from './JiraLogo.js'
import { getRuntime } from './runtime.js'

export interface TicketChipProps {
  sessionId: string
  t: (key: string, params?: Record<string, string | number>) => string
}

interface BindingResponse {
  ok?: boolean
  bound?: boolean
  key?: string | null
  summary?: string | null
  statusName?: string | null
  url?: string | null
}

/** How often the chip re-reads the binding; the binding changes rarely. */
const POLL_MS = 5000

export function TicketChip({ sessionId, t }: TicketChipProps): React.ReactElement | null {
  const [binding, setBinding] = React.useState<BindingResponse | null>(null)
  const runtime = React.useMemo(getRuntime, [])

  React.useEffect(() => {
    let alive = true
    const read = async (): Promise<void> => {
      try {
        const r = await runtime.fetchJson<BindingResponse>(
          `/api/scjira/worklog?sessionId=${encodeURIComponent(sessionId)}`,
        )
        if (alive) setBinding(r)
      } catch {
        // A chip that cannot read the binding shows nothing; it must never
        // break the composer.
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [runtime, sessionId])

  if (binding?.bound !== true || !binding.key) return null

  const title = [binding.key, binding.summary, binding.statusName].filter(Boolean).join(' · ')

  return (
    <a
      href={binding.url ?? undefined}
      target="_blank"
      rel="noreferrer"
      title={title}
      aria-label={t('ticket.chip', { key: binding.key })}
      style={{
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: '100%',
        padding: '1px 8px',
        borderRadius: 'var(--dsw-radius-sm)',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
        textDecoration: 'none',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={event => {
        event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
        event.currentTarget.style.color = 'var(--dsw-alias-label-secondary)'
      }}
      onMouseLeave={event => {
        event.currentTarget.style.background = 'transparent'
        event.currentTarget.style.color = 'var(--dsw-alias-label-tertiary)'
      }}
    >
      <JiraLogo size={14} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{binding.key}</span>
      {binding.statusName !== null && binding.statusName !== '' && (
        <span style={{ color: 'var(--dsw-alias-label-caption)' }}>{binding.statusName}</span>
      )}
    </a>
  )
}
