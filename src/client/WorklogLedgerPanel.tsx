/**
 * WorklogLedgerPanel — the local worklog ledger, for review and upload.
 *
 * The ledger is filled automatically as the session works. Nothing reaches
 * Jira until a person says so: this panel lists every entry, lets a
 * duration be corrected, and uploads the entries the user SELECTS.
 *
 * The selection is the point. A button that uploaded everything would make
 * the review decorative — the entries would land on the tracker whether or
 * not anyone looked at them. Checking boxes is the review.
 */
import * as React from 'react'

interface WorklogEntryView {
  id: string
  turn: number | null
  seconds: number
  duration: string
  comment: string
  startedAt: string
  state: 'draft' | 'synced' | 'failed'
  jiraId: string | null
  createdAt: string
  syncedAt: string | null
  error: string | null
}

interface WorklogLedgerView {
  key: string
  entries: WorklogEntryView[]
  totalSeconds: number
  totalDuration: string
  draftCount: number
  syncedCount: number
  failedCount: number
}

export interface WorklogLedgerPanelProps {
  /** The bound issue key; empty when nothing is bound. */
  issueKey: string
  /** Fetch a JSON payload from the host. */
  fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>
  /** Localized labels. */
  t: (key: string, params?: Record<string, string | number>) => string
}

const FG = 'var(--dsw-alias-label-primary)'
const FG_MUTED = 'var(--dsw-alias-label-secondary)'
const FG_FAINT = 'var(--dsw-alias-label-tertiary)'
const BORDER = 'var(--dsw-alias-border-l2)'
const BORDER_SOFT = 'var(--dsw-alias-border-l1)'
const INPUT_BG = 'var(--dsw-alias-bg-overlay)'
const ACCENT = '#2684ff'
const SUCCESS = '#36b37e'
const ERROR = '#de350b'

const STATE_COLOR: Record<WorklogEntryView['state'], string> = {
  draft: FG_MUTED,
  synced: SUCCESS,
  failed: ERROR,
}

/** Format an ISO timestamp as a local date-time, or leave it alone. */
function formatWhen(iso: string): string {
  if (!iso) return ''
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso)
  if (m === null) return iso
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

export function WorklogLedgerPanel({ issueKey, fetchJson, t }: WorklogLedgerPanelProps): React.ReactElement {
  const [ledger, setLedger] = React.useState<WorklogLedgerView | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<WorklogEntryView | null>(null)

  const reload = React.useCallback(async () => {
    if (!issueKey) {
      setLedger(null)
      return
    }
    setLoading(true)
    try {
      const res = await fetchJson<{ ok: boolean; ledger?: WorklogLedgerView }>(
        `/api/scjira/worklog?key=${encodeURIComponent(issueKey)}`,
      )
      if (res.ok && res.ledger) {
        setLedger(res.ledger)
        // Keep the selection to entries that still exist and still need
        // uploading — a synced entry has nothing left to send.
        setSelected(prev => {
          const next = new Set<string>()
          for (const id of prev) {
            const entry = res.ledger?.entries.find(e => e.id === id)
            if (entry !== undefined && entry.state !== 'synced') next.add(id)
          }
          return next
        })
      }
    } catch {
      setError('failed to read the ledger')
    } finally {
      setLoading(false)
    }
  }, [fetchJson, issueKey])

  React.useEffect(() => { void reload() }, [reload])

  if (!issueKey) {
    return (
      <div style={{ padding: 12, color: FG_MUTED }}>{t('worklog.unbound')}</div>
    )
  }

  if (loading && ledger === null) {
    return <div style={{ padding: 12, color: FG_MUTED }}>{t('status.loading')}</div>
  }

  const entries = ledger?.entries ?? []
  const draftEntries = entries.filter(e => e.state !== 'synced')
  const selectedCount = selected.size

  async function upload() {
    if (selectedCount === 0 || busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await fetchJson<{ ok: boolean; syncedCount?: number; uploaded?: Array<{ ok: boolean; error?: string }> }>(
        '/api/scjira/worklog/upload',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: issueKey, ids: [...selected] }),
        },
      )
      if (!res.ok) {
        setError('upload failed')
      } else {
        const failed = (res.uploaded ?? []).filter(u => !u.ok)
        if (failed.length > 0) {
          setError(failed[0]?.error ?? 'some entries were rejected')
        } else {
          setMessage(t('worklog.uploaded', { count: res.syncedCount ?? selectedCount }))
        }
      }
      await reload()
    } catch {
      setError('upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit() {
    if (editing === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetchJson<{ ok: boolean; error?: string }>('/api/scjira/worklog/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: issueKey,
          id: editing.id,
          seconds: editing.seconds,
          comment: editing.comment,
          startedAt: editing.startedAt,
        }),
      })
      if (!res.ok) {
        setError(res.error ?? 'edit failed')
      } else {
        setEditing(null)
        setMessage(t('worklog.edited'))
        await reload()
      }
    } catch {
      setError('edit failed')
    } finally {
      setBusy(false)
    }
  }

  async function repull() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetchJson<{ ok: boolean; updated?: number; added?: number }>(
        '/api/scjira/worklog/repull',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: issueKey }),
        },
      )
      if (!res.ok) {
        setError('could not read the Jira worklogs')
      } else {
        setMessage(t('worklog.repulled', { updated: res.updated ?? 0, added: res.added ?? 0 }))
        await reload()
      }
    } catch {
      setError('could not read the Jira worklogs')
    } finally {
      setBusy(false)
    }
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
        color: FG_MUTED, fontSize: 13, flexWrap: 'wrap',
      }}>
        <span>
          {t('worklog.total', {
            count: entries.length,
            duration: ledger?.totalDuration ?? '0m',
          })}
        </span>
        <span>·</span>
        <span style={{ color: FG_MUTED }}>{t('worklog.draft', { count: ledger?.draftCount ?? 0 })}</span>
        <span>·</span>
        <span style={{ color: SUCCESS }}>{t('worklog.synced', { count: ledger?.syncedCount ?? 0 })}</span>
        {ledger !== null && ledger.failedCount > 0 && (
          <>
            <span>·</span>
            <span style={{ color: ERROR }}>{t('worklog.failed', { count: ledger.failedCount })}</span>
          </>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void repull()}
          disabled={busy}
          title={t('worklog.repull.hint')}
          style={{
            padding: '2px 8px', background: 'transparent', color: FG_MUTED,
            border: `1px solid ${BORDER_SOFT}`, borderRadius: 4, cursor: busy ? 'default' : 'pointer',
            font: 'inherit', fontSize: 12,
          }}
        >
          {t('worklog.repull')}
        </button>
      </div>

      {entries.length === 0 ? (
        <div style={{ padding: 12, color: FG_MUTED }}>{t('worklog.empty')}</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', font: '13px/20px sans-serif', color: FG }}>
          <thead>
            <tr>
              <th style={{ width: 28, padding: '6px 4px' }} />
              <th style={{ textAlign: 'left', padding: '8px 6px 6px', color: FG_MUTED, fontWeight: 500, fontSize: 12 }}>
                {t('worklog.when')}
              </th>
              <th style={{ textAlign: 'left', padding: '8px 6px 6px', color: FG_MUTED, fontWeight: 500, fontSize: 12 }}>
                {t('worklog.duration')}
              </th>
              <th style={{ textAlign: 'left', padding: '8px 6px 6px', color: FG_MUTED, fontWeight: 500, fontSize: 12 }}>
                {t('worklog.comment')}
              </th>
              <th style={{ textAlign: 'left', padding: '8px 6px 6px', color: FG_MUTED, fontWeight: 500, fontSize: 12 }}>
                {t('worklog.state')}
              </th>
              <th style={{ width: 56, padding: '8px 6px 6px' }} />
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={entry.id} style={{ borderBottom: `1px solid ${BORDER_SOFT}` }}>
                <td style={{ padding: '8px 4px', verticalAlign: 'top' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(entry.id)}
                    disabled={entry.state === 'synced'}
                    onChange={() => toggle(entry.id)}
                    aria-label={t('worklog.select', { id: entry.id })}
                    style={{ cursor: entry.state === 'synced' ? 'default' : 'pointer' }}
                  />
                </td>
                <td style={{ padding: '8px 6px', color: FG, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                  {formatWhen(entry.startedAt)}
                  {entry.turn !== null && (
                    <div style={{ fontSize: 11, color: FG_FAINT }}>turn {entry.turn}</div>
                  )}
                </td>
                <td style={{ padding: '8px 6px', color: FG, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                  {entry.duration}
                </td>
                <td style={{ padding: '8px 6px', color: FG_MUTED, verticalAlign: 'top' }}>
                  {entry.comment || '—'}
                  {entry.error !== null && (
                    <div style={{ fontSize: 11, color: ERROR }}>{entry.error}</div>
                  )}
                </td>
                <td style={{ padding: '8px 6px', color: STATE_COLOR[entry.state], whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                  {entry.state}
                  {entry.jiraId !== null && (
                    <div style={{ fontSize: 11, color: FG_FAINT }}>#{entry.jiraId}</div>
                  )}
                </td>
                <td style={{ padding: '8px 6px', verticalAlign: 'top' }}>
                  <button
                    type="button"
                    onClick={() => setEditing(entry)}
                    disabled={busy}
                    style={{
                      padding: '1px 8px', background: 'transparent', color: FG_MUTED,
                      border: `1px solid ${BORDER}`, borderRadius: 4,
                      cursor: busy ? 'default' : 'pointer', font: 'inherit', fontSize: 12,
                    }}
                  >
                    {t('worklog.edit')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          onClick={() => {
            setSelected(new Set(draftEntries.map(e => e.id)))
          }}
          disabled={busy || draftEntries.length === 0}
          style={{
            padding: '2px 8px', background: 'transparent', color: FG_MUTED,
            border: `1px solid ${BORDER_SOFT}`, borderRadius: 4,
            cursor: draftEntries.length === 0 ? 'default' : 'pointer', font: 'inherit', fontSize: 12,
          }}
        >
          {t('worklog.selectAll')}
        </button>
        <button
          type="button"
          onClick={() => setSelected(new Set())}
          disabled={busy || selectedCount === 0}
          style={{
            padding: '2px 8px', background: 'transparent', color: FG_MUTED,
            border: `1px solid ${BORDER_SOFT}`, borderRadius: 4,
            cursor: selectedCount === 0 ? 'default' : 'pointer', font: 'inherit', fontSize: 12,
          }}
        >
          {t('worklog.clearSelection')}
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void upload()}
          disabled={busy || selectedCount === 0}
          style={{
            padding: '4px 14px',
            background: selectedCount === 0 ? INPUT_BG : ACCENT,
            color: selectedCount === 0 ? FG_FAINT : '#fff',
            border: 'none', borderRadius: 4,
            cursor: selectedCount === 0 || busy ? 'default' : 'pointer',
            fontWeight: 600, font: 'inherit', fontSize: 13,
          }}
        >
          {t('worklog.upload', { count: selectedCount })}
        </button>
      </div>

      {message !== null && (
        <div style={{ marginTop: 8, color: SUCCESS, fontSize: 12 }}>{message}</div>
      )}
      {error !== null && (
        <div style={{ marginTop: 8, color: ERROR, fontSize: 12 }}>{error}</div>
      )}

      {editing !== null && (
        <div style={{
          marginTop: 12, padding: 12,
          background: INPUT_BG, border: `1px solid ${BORDER}`, borderRadius: 4,
        }}>
          <div style={{ marginBottom: 8, color: FG, fontWeight: 600 }}>
            {t('worklog.editTitle')}
          </div>
          <div style={{ display: 'grid', gap: 8, maxWidth: 460 }}>
            <label>
              <div style={{ fontSize: 12, color: FG_MUTED, marginBottom: 2 }}>
                {t('worklog.minutes')}
              </div>
              <input
                type="number"
                min={0}
                value={Math.round(editing.seconds / 60)}
                onChange={e => setEditing({
                  ...editing,
                  seconds: Math.max(0, Number(e.target.value) || 0) * 60,
                })}
                style={{
                  width: '100%', padding: 5, background: 'var(--dsw-alias-bg-base)',
                  color: FG, border: `1px solid ${BORDER}`, borderRadius: 4,
                }}
              />
            </label>
            <label>
              <div style={{ fontSize: 12, color: FG_MUTED, marginBottom: 2 }}>
                {t('worklog.startedAt')}
              </div>
              <input
                type="text"
                value={editing.startedAt}
                onChange={e => setEditing({ ...editing, startedAt: e.target.value })}
                style={{
                  width: '100%', padding: 5, background: 'var(--dsw-alias-bg-base)',
                  color: FG, border: `1px solid ${BORDER}`, borderRadius: 4,
                }}
              />
            </label>
            <label>
              <div style={{ fontSize: 12, color: FG_MUTED, marginBottom: 2 }}>
                {t('worklog.comment')}
              </div>
              <input
                type="text"
                value={editing.comment}
                onChange={e => setEditing({ ...editing, comment: e.target.value })}
                style={{
                  width: '100%', padding: 5, background: 'var(--dsw-alias-bg-base)',
                  color: FG, border: `1px solid ${BORDER}`, borderRadius: 4,
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => void saveEdit()}
                disabled={busy}
                style={{
                  padding: '4px 14px', background: ACCENT, color: '#fff',
                  border: 'none', borderRadius: 4, cursor: busy ? 'default' : 'pointer',
                  fontWeight: 600, font: 'inherit', fontSize: 13,
                }}
              >
                {t('worklog.save')}
              </button>
              <button
                type="button"
                onClick={() => setEditing(null)}
                disabled={busy}
                style={{
                  padding: '4px 14px', background: 'transparent', color: FG_MUTED,
                  border: `1px solid ${BORDER}`, borderRadius: 4, cursor: 'pointer',
                  font: 'inherit', fontSize: 13,
                }}
              >
                {t('worklog.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
