import * as React from 'react'
import type { IssueSummary } from '../types.js'

interface ListMyOpenPanelProps {
  t: (key: string) => string
}

export function ListMyOpenPanel({ t }: ListMyOpenPanelProps): React.ReactElement {
  const [issues, setIssues] = React.useState<IssueSummary[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let aborted = false
    fetch('/api/scjira/list-my-open', { credentials: 'include' })
      .then(r => r.json())
      .then((body: { ok: boolean; issues?: IssueSummary[]; error?: string }) => {
        if (aborted) return
        if (body.ok && body.issues) setIssues(body.issues)
        else setError(body.error ?? 'unknown')
      })
      .catch(err => { if (!aborted) setError(String(err)) })
    return () => { aborted = true }
  }, [])

  if (error) return <div style={{ color: 'var(--dsh-error, #f55)' }}>{t('error.network')}: {error}</div>
  if (issues === null) return <div>...</div>
  if (issues.length === 0) return <div>{t('status.empty')}</div>

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {issues.map(i => (
        <li key={i.key} style={{ borderBottom: '1px solid var(--dsh-border, #333)', padding: '8px 0' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <strong style={{ fontFamily: 'monospace' }}>{i.key}</strong>
            <span style={{ background: 'var(--dsh-pill, #234)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>{i.statusName}</span>
            <span style={{ background: 'var(--dsh-pill, #432)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>{i.priority}</span>
          </div>
          <div style={{ marginTop: 4 }}>{i.summary}</div>
          {i.description && (
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>{i.description.slice(0, 200)}</div>
          )}
          {i.duedate && (
            <div style={{ marginTop: 4, fontSize: 11, opacity: 0.6 }}>due {i.duedate}</div>
          )}
        </li>
      ))}
    </ul>
  )
}
