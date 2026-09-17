import * as React from 'react'
import type { DayTotal } from '../types.js'

interface WorklogWeekPanelProps {
  t: (key: string) => string
}

interface WeekResponse {
  ok: boolean
  weekStart?: string
  weekEnd?: string
  dayLabels?: Array<{ date: string; label: string; seconds: number }>
  dailyTotals?: Record<string, DayTotal>
  grandTotalSeconds?: number
  error?: string
}

export function WorklogWeekPanel({ t }: WorklogWeekPanelProps): React.ReactElement {
  const [data, setData] = React.useState<WeekResponse | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let aborted = false
    fetch('/api/scjira/list-worklog-week', { credentials: 'include' })
      .then(r => r.json())
      .then(body => { if (!aborted) setData(body) })
      .catch(err => { if (!aborted) setError(String(err)) })
    return () => { aborted = true }
  }, [])

  if (error) return <div style={{ color: 'var(--dsh-error, #f55)' }}>{t('error.network')}: {error}</div>
  if (!data) return <div>...</div>
  if (!data.ok) return <div style={{ color: 'var(--dsh-error, #f55)' }}>{data.error}</div>

  const max = Math.max(1, ...(data.dayLabels ?? []).map(d => d.seconds))

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120, padding: '8px 0' }}>
        {(data.dayLabels ?? []).map(d => (
          <div key={d.date} style={{ flex: 1, textAlign: 'center' }}>
            <div
              style={{
                height: `${(d.seconds / max) * 100}%`,
                background: 'var(--dsh-accent, #4af)',
                minHeight: 2,
                borderRadius: 2,
              }}
              title={`${d.date}: ${d.seconds}s`}
            />
            <div style={{ fontSize: 10, marginTop: 2 }}>{d.label}</div>
            <div style={{ fontSize: 9, opacity: 0.6 }}>{(d.seconds / 3600).toFixed(1)}h</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, marginTop: 8 }}>
        Total: {((data.grandTotalSeconds ?? 0) / 3600).toFixed(2)}h
      </div>
    </div>
  )
}
