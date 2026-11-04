/**
 * 「本次 Worklog」 — the panel for the session's own round.
 *
 * Three blocks, in the order the work happens:
 *
 *   binding   — which issue, how much is recorded, how much the host measured
 *   activities— what the agent recorded, one line each
 *   draft     — the entries generated from those records, with upload
 *
 * The panel never generates: generation is the agent's answer to the user
 * asking for it. It does own the review — selecting entries, editing a draft,
 * discarding one — because those are decisions about what reaches the tracker.
 */
import * as React from 'react'
import {
  ACCENT,
  BORDER,
  BORDER_SOFT,
  ERROR,
  FG,
  FG_FAINT,
  FG_MUTED,
  INPUT_BG,
  SUCCESS,
  cardStyle,
  fmtInstant,
  fmtSeconds,
  ghostButtonStyle,
  inputStyle,
  primaryButtonStyle,
  tdStyle,
  thStyle,
  tableStyle,
} from './theme.js'

export interface ActivityView {
  id: string
  summary: string
  startedAt: string
  seconds: number
  turn: number | null
  source: 'agent' | 'derived'
}

export interface DraftEntryView {
  id: string
  startedAt: string
  seconds: number
  comment: string
  activityIds: string[]
  state: 'draft' | 'synced' | 'failed'
  jiraId: string | null
  syncedAt: string | null
  error: string | null
}

export interface WorklogStateResponse {
  ok?: boolean
  bound?: boolean
  key?: string | null
  summary?: string | null
  statusName?: string | null
  url?: string | null
  activityCount?: number
  recordedSeconds?: number
  measuredSeconds?: number
  gapSeconds?: number
  uncoveredCount?: number
  draftCount?: number
  pendingCount?: number
  syncedCount?: number
  failedCount?: number
  settled?: boolean
  activities?: ActivityView[]
  draft?: DraftEntryView[]
  uncoveredIds?: string[]
  generatedAt?: string | null
  error?: string
}

type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>

interface WorklogPanelProps {
  sessionId: string
  t: (key: string, params?: Record<string, string | number>) => string
  fetchJson: FetchJson
}

const POLL_MS = 4000

export function WorklogPanel({ sessionId, t, fetchJson }: WorklogPanelProps): React.ReactElement {
  const [state, setState] = React.useState<WorklogStateResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [editing, setEditing] = React.useState<DraftEntryView | null>(null)

  const reload = React.useCallback(async () => {
    try {
      const r = await fetchJson<WorklogStateResponse>(`/api/scjira/worklog?sessionId=${encodeURIComponent(sessionId)}`)
      setState(r)
      // Keep only selections that are still pending, so an upload that just
      // succeeded does not leave a dangling checkbox.
      setSelected(prev => {
        const pending = new Set((r.draft ?? []).filter(entry => entry.state !== 'synced').map(entry => entry.id))
        const next = new Set([...prev].filter(id => pending.has(id)))
        return next.size === prev.size && [...next].every(id => prev.has(id)) ? prev : next
      })
    } catch {
      setNotice({ tone: 'bad', text: t('error.network') })
    } finally {
      setLoading(false)
    }
  }, [fetchJson, sessionId, t])

  React.useEffect(() => { void reload() }, [reload])

  // The agent records while the conversation runs, so the panel refreshes on
  // its own instead of asking the reader to hit reload.
  React.useEffect(() => {
    const timer = setInterval(() => { void reload() }, POLL_MS)
    return () => clearInterval(timer)
  }, [reload])

  const pending = (state?.draft ?? []).filter(entry => entry.state !== 'synced')

  function toggle(id: string): void {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function upload(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      setNotice({ tone: 'bad', text: t('worklog.selectFirst') })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const r = await fetchJson<{ ok?: boolean; uploaded?: Array<{ id: string; ok: boolean; error?: string }>; error?: string }>(
        '/api/scjira/worklog/upload',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, ids }),
        },
      )
      if (r.ok !== true) {
        setNotice({ tone: 'bad', text: r.error ?? t('worklog.uploadFailed') })
      } else {
        const okCount = (r.uploaded ?? []).filter(item => item.ok).length
        const failed = (r.uploaded ?? []).filter(item => !item.ok)
        setNotice(failed.length === 0
          ? { tone: 'ok', text: t('worklog.uploaded', { count: okCount }) }
          : { tone: 'bad', text: t('worklog.uploadPartial', { ok: okCount, failed: failed.length }) })
        setSelected(new Set())
      }
      await reload()
    } catch {
      setNotice({ tone: 'bad', text: t('error.network') })
    } finally {
      setBusy(false)
    }
  }

  async function discard(): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const r = await fetchJson<{ ok?: boolean; removed?: number; error?: string }>(
        '/api/scjira/worklog/discard',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        },
      )
      setNotice(r.ok === true
        ? { tone: 'ok', text: t('worklog.discarded', { count: r.removed ?? 0 }) }
        : { tone: 'bad', text: r.error ?? t('worklog.discardFailed') })
      await reload()
    } catch {
      setNotice({ tone: 'bad', text: t('error.network') })
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit(entry: DraftEntryView, seconds: number, comment: string): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const r = await fetchJson<{ ok?: boolean; error?: string }>('/api/scjira/worklog/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, id: entry.id, seconds, comment }),
      })
      setNotice(r.ok === true
        ? { tone: 'ok', text: t('worklog.edited') }
        : { tone: 'bad', text: r.error ?? t('worklog.editFailed') })
      if (r.ok === true) setEditing(null)
      await reload()
    } catch {
      setNotice({ tone: 'bad', text: t('error.network') })
    } finally {
      setBusy(false)
    }
  }

  if (loading && state === null) {
    return <div style={{ padding: 12, color: FG_MUTED }}>{t('status.loading')}</div>
  }

  const bound = state?.bound === true

  return (
    <div>
      {/* Binding */}
      <div style={{ marginBottom: 16, padding: '10px 12px', background: INPUT_BG, borderRadius: 6 }}>
        {bound ? (
          <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 10 }}>
            <a
              href={state?.url ?? undefined}
              target="_blank"
              rel="noreferrer"
              style={{ color: ACCENT, fontWeight: 600, textDecoration: 'none' }}
            >
              {state?.key}
            </a>
            <span style={{ fontSize: 13 }}>{state?.summary}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button type="button" disabled={busy} style={ghostButtonStyle} onClick={() => { void discard() }}>
                {t('worklog.discard')}
              </button>
            </span>
          </div>
        ) : (
          <div style={{ color: FG_MUTED }}>{t('worklog.unbound')}</div>
        )}
      </div>

      {bound && (
        <>
          {/* Totals */}
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 14, fontSize: 13, color: FG_MUTED }}>
            <span>{t('worklog.recorded')}: <strong style={{ color: FG }}>{fmtSeconds(state?.recordedSeconds ?? 0)}</strong> / {state?.activityCount ?? 0} {t('worklog.records')}</span>
            <span>{t('worklog.measured')}: <strong style={{ color: FG }}>{fmtSeconds(state?.measuredSeconds ?? 0)}</strong></span>
            <span>
              {t('worklog.gap')}:{' '}
              <strong style={{ color: (state?.gapSeconds ?? 0) === 0 ? FG : FG_FAINT }}>
                {fmtSeconds(Math.abs(state?.gapSeconds ?? 0))}
              </strong>
            </span>
          </div>

          {/* Activities */}
          <div style={{ marginBottom: 6, color: FG_MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {t('worklog.activities')}
          </div>
          {(state?.activities ?? []).length === 0 ? (
            <div style={{ padding: '6px 0', color: FG_MUTED, fontSize: 13 }}>{t('worklog.noActivities')}</div>
          ) : (
            <table style={{ ...tableStyle, marginBottom: 18 }}>
              <tbody>
                {(state?.activities ?? []).map(activity => (
                  <tr key={activity.id}>
                    <td style={{ ...tdStyle, color: FG_MUTED, whiteSpace: 'nowrap', width: 110 }}>{fmtInstant(activity.startedAt)}</td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', width: 70 }}>{fmtSeconds(activity.seconds)}</td>
                    <td style={tdStyle}>{activity.summary}</td>
                    <td style={{ ...tdStyle, color: FG_FAINT, whiteSpace: 'nowrap', width: 90, textAlign: 'right' }}>
                      {activity.turn !== null ? `turn ${activity.turn}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Draft */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
            <span style={{ color: FG_MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {t('worklog.draft')}
            </span>
            {state?.generatedAt != null && (
              <span style={{ color: FG_FAINT, fontSize: 12 }}>{t('worklog.generatedAt')} {fmtInstant(state.generatedAt)}</span>
            )}
          </div>

          {(state?.draft ?? []).length === 0 ? (
            <div style={{ padding: '6px 0', color: FG_MUTED, fontSize: 13 }}>{t('worklog.noDraft')}</div>
          ) : (
            <>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 28 }} aria-label={t('worklog.select')} />
                    <th style={thStyle}>{t('worklog.when')}</th>
                    <th style={thStyle}>{t('worklog.duration')}</th>
                    <th style={thStyle}>{t('worklog.comment')}</th>
                    <th style={thStyle}>{t('worklog.state')}</th>
                    <th style={{ ...thStyle, width: 60 }} />
                  </tr>
                </thead>
                <tbody>
                  {(state?.draft ?? []).map(entry => {
                    const synced = entry.state === 'synced'
                    return (
                      <tr key={entry.id}>
                        <td style={tdStyle}>
                          <input
                            type="checkbox"
                            checked={selected.has(entry.id)}
                            disabled={synced || busy}
                            onChange={() => toggle(entry.id)}
                            aria-label={t('worklog.selectEntry', { id: entry.id })}
                          />
                        </td>
                        <td style={{ ...tdStyle, color: FG_MUTED, whiteSpace: 'nowrap' }}>{fmtInstant(entry.startedAt)}</td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{fmtSeconds(entry.seconds)}</td>
                        <td style={tdStyle}>
                          {entry.comment}
                          {entry.error !== null && (
                            <div style={{ color: ERROR, fontSize: 12, marginTop: 2 }}>{entry.error}</div>
                          )}
                        </td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                          <StateBadge t={t} state={entry.state} jiraId={entry.jiraId} />
                        </td>
                        <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                          {!synced && (
                            <button
                              type="button"
                              disabled={busy}
                              style={{ ...ghostButtonStyle, padding: '2px 8px' }}
                              onClick={() => setEditing(entry)}
                            >
                              {t('worklog.edit')}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
                <button
                  type="button"
                  disabled={busy || pending.length === 0}
                  style={{ ...primaryButtonStyle, opacity: busy || pending.length === 0 ? 0.5 : 1 }}
                  onClick={() => { void upload([...selected]) }}
                >
                  {t('worklog.uploadSelected', { count: selected.size })}
                </button>
                <button
                  type="button"
                  disabled={busy || pending.length === 0}
                  style={ghostButtonStyle}
                  onClick={() => setSelected(new Set(pending.map(entry => entry.id)))}
                >
                  {t('worklog.selectAll')}
                </button>
                <button
                  type="button"
                  disabled={busy || selected.size === 0}
                  style={ghostButtonStyle}
                  onClick={() => setSelected(new Set())}
                >
                  {t('worklog.clearSelection')}
                </button>
              </div>
            </>
          )}

          {editing !== null && (
            <EditDialog
              entry={editing}
              t={t}
              busy={busy}
              onCancel={() => setEditing(null)}
              onSave={(seconds, comment) => { void saveEdit(editing, seconds, comment) }}
            />
          )}
        </>
      )}

      {notice !== null && (
        <div style={{ marginTop: 10, color: notice.tone === 'ok' ? SUCCESS : ERROR, fontSize: 13 }}>
          {notice.text}
        </div>
      )}

      <div style={{ marginTop: 14, paddingTop: 10, borderTop: `1px solid ${BORDER_SOFT}`, color: FG_FAINT, fontSize: 12 }}>
        {t('worklog.hint')}
      </div>
    </div>
  )
}

function StateBadge({
  t,
  state,
  jiraId,
}: {
  t: WorklogPanelProps['t']
  state: DraftEntryView['state']
  jiraId: string | null
}): React.ReactElement {
  const color = state === 'synced' ? SUCCESS : state === 'failed' ? ERROR : FG_MUTED
  const label = state === 'synced'
    ? `${t('worklog.synced')}${jiraId !== null ? ` #${jiraId}` : ''}`
    : state === 'failed'
      ? t('worklog.failed')
      : t('worklog.pending')
  return <span style={{ color, fontSize: 12 }}>{label}</span>
}

function EditDialog({
  entry,
  t,
  busy,
  onCancel,
  onSave,
}: {
  entry: DraftEntryView
  t: WorklogPanelProps['t']
  busy: boolean
  onCancel: () => void
  onSave: (seconds: number, comment: string) => void
}): React.ReactElement {
  const [minutes, setMinutes] = React.useState(String(Math.max(1, Math.round(entry.seconds / 60))))
  const [comment, setComment] = React.useState(entry.comment)
  const parsed = Number(minutes)
  const valid = Number.isFinite(parsed) && parsed > 0

  return (
    <div
      role="dialog"
      aria-label={t('worklog.editTitle')}
      style={{
        marginTop: 12,
        padding: 12,
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        background: INPUT_BG,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>{t('worklog.editTitle')} — {entry.id}</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        {t('worklog.minutes')}
        <input
          value={minutes}
          onChange={event => setMinutes(event.target.value)}
          inputMode="numeric"
          style={{ ...inputStyle, width: 90 }}
          disabled={busy}
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
        {t('worklog.comment')}
        <input
          value={comment}
          onChange={event => setComment(event.target.value)}
          style={inputStyle}
          disabled={busy}
        />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          disabled={busy || !valid}
          style={{ ...primaryButtonStyle, opacity: busy || !valid ? 0.5 : 1 }}
          onClick={() => onSave(Math.round(parsed * 60), comment)}
        >
          {t('worklog.save')}
        </button>
        <button type="button" disabled={busy} style={ghostButtonStyle} onClick={onCancel}>
          {t('worklog.cancel')}
        </button>
      </div>
    </div>
  )
}
