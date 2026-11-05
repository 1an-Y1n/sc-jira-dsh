/**
 * 「本次 Worklog」 — the session's own round, presented in the harness's own
 * visual language.
 *
 * Layout, top to bottom, each block answering one question:
 *
 *   ticket   — which issue is this session on, and how far along is the work?
 *   worklog  — the entries that will reach Jira; every cell is editable
 *   records  — the agent's raw notes, editable until they are turned into
 *              entries (after that the draft is the surface to edit)
 *
 * The panel never generates: generation is the agent's answer to the user
 * asking for it. It owns the review — selecting, editing, discarding — because
 * those are decisions about what reaches the tracker.
 *
 * Controls come from `@deepseek-ai/dsh-client-ui-primitives`, so the panel
 * inherits the harness's buttons, inputs, tags and spacing instead of
 * imitating them.
 */
import * as React from 'react'
import {
  Button,
  Checkbox,
  DisclosureRow,
  IconClockOutlineRegular,
  Input,
  Tag,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { BORDER_SOFT, FG, FG_FAINT, FG_MUTED, bodyCell, fmtInstant, fmtSeconds, headCell } from './theme.js'

export interface ActivityView {
  id: string
  summary: string
  startedAt: string
  seconds: number
  turn: number | null
  source: 'agent' | 'derived'
  /** The entry that already accounts for this record, or null. */
  coveredBy: string | null
  editable: boolean
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
  /** True when the host made this entry from a finished turn. */
  auto?: boolean
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

/** Section label: the small, quiet heading the harness uses above a group. */
function SectionLabel({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '18px 0 8px' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: FG_MUTED, letterSpacing: '0.02em' }}>{children}</span>
      {trailing !== undefined && <span style={{ marginLeft: 'auto', fontSize: 12, color: FG_FAINT }}>{trailing}</span>}
    </div>
  )
}

/**
 * One editable cell.
 *
 * Renders its text until clicked, then a single-line input: Enter or blur
 * saves, Escape cancels. `onCommit` may reject — the cell then stays in edit
 * mode with the message surfaced by the panel, so nothing is lost.
 */
function EditCell({
  label,
  text,
  value,
  width,
  disabled,
  onCommit,
}: {
  label: string
  text: string
  value: string
  width?: number
  disabled?: boolean
  onCommit: (next: string) => Promise<void> | void
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  async function commit(): Promise<void> {
    if (busy) return
    if (draft === value) { setEditing(false); return }
    setBusy(true)
    try {
      await onCommit(draft)
      setEditing(false)
    } catch {
      // Keep the editor open: the panel shows the reason and the typed value
      // is still there to fix.
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        title={label}
        disabled={disabled}
        onClick={() => { setDraft(value); setEditing(true) }}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          font: 'inherit',
          color: FG,
          textAlign: 'left',
          cursor: disabled === true ? 'default' : 'text',
          borderBottom: disabled === true ? '1px dotted transparent' : '1px dotted var(--dsw-alias-border-l3)',
          opacity: disabled === true ? 0.75 : 1,
          whiteSpace: 'nowrap',
        }}
      >
        {text}
      </button>
    )
  }

  return (
    <Input
      autoFocus
      value={draft}
      aria-label={label}
      disabled={busy}
      style={width !== undefined ? { width } : undefined}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => { void commit() }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); void commit() }
        if (event.key === 'Escape') { event.preventDefault(); setDraft(value); setEditing(false) }
      }}
    />
  )
}

/** `MM-DD HH:mm` (or a full ISO date) → an ISO instant with +0800, or null. */
function parseTimeCell(text: string, base: string): string | null {
  const baseYear = /^(\d{4})-/.exec(base)?.[1] ?? String(new Date().getFullYear())
  const short = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (short !== null) {
    const [, mo, day, hour, minute] = short
    const iso = `${baseYear}-${mo!.padStart(2, '0')}-${day!.padStart(2, '0')}T${hour!.padStart(2, '0')}:${minute}:00.000+0800`
    return Number.isNaN(Date.parse(iso)) ? null : iso
  }
  const full = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(text.trim())
  if (full !== null) {
    const [, y, mo, day, hour, minute] = full
    return `${y}-${mo}-${day}T${hour}:${minute}:00.000+0800`
  }
  return null
}

/** A duration in minutes, as seconds; null when the text is not a positive integer. */
function parseMinutes(text: string): number | null {
  const value = Number(text.trim())
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 60)
}

function stateTag(t: WorklogPanelProps['t'], entry: DraftEntryView): { tone: TagTone; label: string } {
  if (entry.state === 'synced') {
    return { tone: 'success', label: entry.jiraId !== null ? `${t('worklog.synced')} #${entry.jiraId}` : t('worklog.synced') }
  }
  if (entry.state === 'failed') return { tone: 'danger', label: t('worklog.failed') }
  return { tone: 'neutral', label: t('worklog.pending') }
}

export function WorklogPanel({ sessionId, t, fetchJson }: WorklogPanelProps): React.ReactElement {
  const [state, setState] = React.useState<WorklogStateResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [recordsOpen, setRecordsOpen] = React.useState(false)

  const reload = React.useCallback(async () => {
    try {
      const r = await fetchJson<WorklogStateResponse>(`/api/scjira/worklog?sessionId=${encodeURIComponent(sessionId)}`)
      setState(r)
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
  // its own rather than asking the reader to reload.
  React.useEffect(() => {
    const timer = setInterval(() => { void reload() }, POLL_MS)
    return () => clearInterval(timer)
  }, [reload])

  /** POST one worklog operation, then refresh; throws so a cell keeps its editor. */
  async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    setBusy(true)
    setNotice(null)
    try {
      const r = await fetchJson<T & { ok?: boolean; error?: string }>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...body }),
      })
      await reload()
      if (r.ok !== true) throw new Error(r.error ?? t('error.network'))
      return r
    } catch (err) {
      setNotice({ tone: 'bad', text: (err as Error).message })
      throw err
    } finally {
      setBusy(false)
    }
  }

  async function upload(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      setNotice({ tone: 'bad', text: t('worklog.selectFirst') })
      return
    }
    try {
      const r = await post<{ uploaded?: Array<{ ok: boolean }> }>('/api/scjira/worklog/upload', { ids })
      const ok = (r.uploaded ?? []).filter(item => item.ok).length
      const failed = (r.uploaded ?? []).length - ok
      setNotice(failed === 0
        ? { tone: 'ok', text: t('worklog.uploaded', { count: ok }) }
        : { tone: 'bad', text: t('worklog.uploadPartial', { ok, failed }) })
      setSelected(new Set())
    } catch {
      // post() already reported it
    }
  }

  async function discard(): Promise<void> {
    try {
      const r = await post<{ removed?: number }>('/api/scjira/worklog/discard', {})
      setNotice({ tone: 'ok', text: t('worklog.discarded', { count: r.removed ?? 0 }) })
    } catch {
      // reported
    }
  }

  async function saveEntry(entry: DraftEntryView, patch: { seconds?: number; comment?: string; startedAt?: string }): Promise<void> {
    try {
      await post('/api/scjira/worklog/edit', { id: entry.id, ...patch })
    } catch (err) {
      throw err
    }
  }

  async function saveActivity(activity: ActivityView, patch: { seconds?: number; comment?: string; startedAt?: string }): Promise<void> {
    try {
      await post('/api/scjira/worklog/activity', {
        id: activity.id,
        seconds: patch.seconds,
        summary: patch.comment,
        startedAt: patch.startedAt,
      })
    } catch (err) {
      throw err
    }
  }

  async function removeEntry(entry: DraftEntryView): Promise<void> {
    try {
      await post('/api/scjira/worklog/delete-entry', { id: entry.id })
      setSelected(prev => {
        const next = new Set(prev)
        next.delete(entry.id)
        return next
      })
      setNotice({ tone: 'ok', text: t('worklog.entryRemoved') })
    } catch {
      // reported
    }
  }

  async function removeActivity(activity: ActivityView): Promise<void> {
    try {
      await post('/api/scjira/worklog/activity', { id: activity.id, delete: true })
      setNotice({ tone: 'ok', text: t('worklog.recordRemoved') })
    } catch {
      // reported
    }
  }

  if (loading && state === null) {
    return <div style={{ padding: 24, color: FG_MUTED, fontSize: 13 }}>{t('status.loading')}</div>
  }

  const bound = state?.bound === true

  if (!bound) {
    return (
      <div style={{ padding: '32px 16px', textAlign: 'center', color: FG_MUTED, fontSize: 13, lineHeight: '22px' }}>
        <div style={{ fontSize: 14, color: FG, marginBottom: 6 }}>{t('worklog.unboundTitle')}</div>
        {t('worklog.unbound')}
      </div>
    )
  }

  const activities = state?.activities ?? []
  const entries = state?.draft ?? []
  const pending = entries.filter(entry => entry.state !== 'synced')
  const gap = Math.abs(state?.gapSeconds ?? 0)

  return (
    <div>
      {/* Ticket */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <a
            href={state?.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-link, #2684ff)', textDecoration: 'none' }}
          >
            {state?.key}
          </a>
          {state?.statusName != null && state.statusName !== '' && <Tag tone="info">{state.statusName}</Tag>}
          <span style={{ marginLeft: 'auto' }}>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void discard() }}>
              {t('worklog.discard')}
            </Button>
          </span>
        </div>
        <div style={{ marginTop: 4, fontSize: 13, color: FG, lineHeight: '20px' }}>{state?.summary}</div>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 12, color: FG_MUTED }}>
          <span>
            {t('worklog.recorded')} <strong style={{ color: FG }}>{fmtSeconds(state?.recordedSeconds ?? 0)}</strong>
            {' · '}{state?.activityCount ?? 0} {t('worklog.records')}
          </span>
          <span>·</span>
          <span>{t('worklog.measured')} <strong style={{ color: FG }}>{fmtSeconds(state?.measuredSeconds ?? 0)}</strong></span>
          {/* A couple of minutes either way is rounding, not a hole in the
              records; only flag a gap worth looking at. */}
          {gap >= 300 && <Tag tone="warning">{t('worklog.gap')} {fmtSeconds(gap)}</Tag>}
        </div>
      </div>

      {/* Worklog */}
      <SectionLabel trailing={t('worklog.entriesCount', { count: entries.length, pending: pending.length })}>
        {t('worklog.draft')}
      </SectionLabel>

      {entries.length === 0 ? (
        <div style={{ padding: '10px 12px', background: 'var(--dsw-alias-bg-overlay)', borderRadius: 8, color: FG_MUTED, fontSize: 13, lineHeight: '20px' }}>
          {activities.length === 0 ? t('worklog.noActivities') : t('worklog.noDraft')}
        </div>
      ) : (
        <div style={{ border: `1px solid ${BORDER_SOFT}`, borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', font: '13px/20px sans-serif' }}>
            <thead>
              <tr style={{ background: 'var(--dsw-alias-bg-overlay)' }}>
                <th style={{ ...headCell, width: 96 }}>{t('worklog.id')}</th>
                <th style={headCell}>{t('worklog.when')}</th>
                <th style={{ ...headCell, width: 90 }}>{t('worklog.duration')}</th>
                <th style={headCell}>{t('worklog.comment')}</th>
                <th style={{ ...headCell, width: 120 }}>{t('worklog.state')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => {
                const tag = stateTag(t, entry)
                return (
                  <tr key={entry.id}>
                    <td style={{ ...bodyCell, whiteSpace: 'nowrap' }}>
                      {/* The primitive's checkbox carries its label visibly:
                          the entry id is useful to show anyway — it is what
                          the upload call and the panel's messages name. */}
                      <Checkbox
                        checked={selected.has(entry.id)}
                        disabled={entry.state === 'synced' || busy}
                        label={entry.id}
                        onChange={() => {
                          setSelected(prev => {
                            const next = new Set(prev)
                            if (next.has(entry.id)) next.delete(entry.id)
                            else next.add(entry.id)
                            return next
                          })
                        }}
                      />
                    </td>
                    <td style={{ ...bodyCell, whiteSpace: 'nowrap', color: FG_MUTED }}>
                      <EditCell
                        label={t('worklog.when')}
                        text={fmtInstant(entry.startedAt)}
                        value={fmtInstant(entry.startedAt)}
                        disabled={busy}
                        onCommit={async text => {
                          const iso = parseTimeCell(text, entry.startedAt)
                          if (iso === null) throw new Error(t('worklog.badTime'))
                          await saveEntry(entry, { startedAt: iso })
                        }}
                      />
                    </td>
                    <td style={{ ...bodyCell, whiteSpace: 'nowrap' }}>
                      <EditCell
                        label={t('worklog.duration')}
                        text={fmtSeconds(entry.seconds)}
                        value={String(Math.round(entry.seconds / 60))}
                        width={64}
                        disabled={busy}
                        onCommit={async text => {
                          const seconds = parseMinutes(text)
                          if (seconds === null) throw new Error(t('worklog.badDuration'))
                          await saveEntry(entry, { seconds })
                        }}
                      />
                    </td>
                    <td style={bodyCell}>
                      <EditCell
                        label={t('worklog.comment')}
                        text={entry.comment}
                        value={entry.comment}
                        disabled={busy}
                        onCommit={async text => {
                          const trimmed = text.trim()
                          if (trimmed === '') throw new Error(t('worklog.badComment'))
                          await saveEntry(entry, { comment: trimmed })
                        }}
                      />
                      {entry.error !== null && (
                        <div style={{ color: 'var(--dsw-alias-label-danger, #de350b)', fontSize: 12, marginTop: 2 }}>{entry.error}</div>
                      )}
                    </td>
                    <td style={{ ...bodyCell, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Tag tone={tag.tone}>{tag.label}</Tag>
                        {entry.auto === true && <Tag tone="quiet">{t('worklog.auto')}</Tag>}
                        {entry.state !== 'synced' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            title={t('worklog.removeEntry')}
                            onClick={() => { void removeEntry(entry) }}
                          >
                            ×
                          </Button>
                        )}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {entries.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => { void upload([...selected]) }}
          >
            {t('worklog.uploadSelected', { count: selected.size })}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || pending.length === 0}
            onClick={() => setSelected(new Set(pending.map(entry => entry.id)))}
          >
            {t('worklog.selectAll')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || selected.size === 0}
            onClick={() => setSelected(new Set())}
          >
            {t('worklog.clearSelection')}
          </Button>
        </div>
      )}

      {/* Raw records — the agent's notes; editable until they become entries. */}
      {activities.length > 0 && (
        <>
          <SectionLabel>{t('worklog.activities')}</SectionLabel>
          <DisclosureRow
            icon={<IconClockOutlineRegular />}
            title={t('worklog.rawRecords')}
            open={recordsOpen}
            expandable
            expandOnRowClick
            onToggle={() => setRecordsOpen(open => !open)}
            collapsedContent={
              <span style={{ color: FG_FAINT, fontSize: 12 }}>
                {t('worklog.recordsCount', {
                  count: activities.length,
                  locked: activities.filter(item => !item.editable).length,
                })}
              </span>
            }
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', font: '12px/18px sans-serif' }}>
              <tbody>
                {activities.map(activity => (
                  <tr key={activity.id}>
                    <td style={{ ...recordCell, whiteSpace: 'nowrap', width: 110, color: FG_MUTED }}>
                      <EditCell
                        label={t('worklog.when')}
                        text={fmtInstant(activity.startedAt)}
                        value={fmtInstant(activity.startedAt)}
                        disabled={busy || !activity.editable}
                        onCommit={async text => {
                          const iso = parseTimeCell(text, activity.startedAt)
                          if (iso === null) throw new Error(t('worklog.badTime'))
                          await saveActivity(activity, { startedAt: iso })
                        }}
                      />
                    </td>
                    <td style={{ ...recordCell, whiteSpace: 'nowrap', width: 70 }}>
                      <EditCell
                        label={t('worklog.duration')}
                        text={fmtSeconds(activity.seconds)}
                        value={String(Math.round(activity.seconds / 60))}
                        width={64}
                        disabled={busy || !activity.editable}
                        onCommit={async text => {
                          const seconds = parseMinutes(text)
                          if (seconds === null) throw new Error(t('worklog.badDuration'))
                          await saveActivity(activity, { seconds })
                        }}
                      />
                    </td>
                    <td style={recordCell}>
                      <EditCell
                        label={t('worklog.comment')}
                        text={activity.summary}
                        value={activity.summary}
                        disabled={busy || !activity.editable}
                        onCommit={async text => {
                          const trimmed = text.trim()
                          if (trimmed === '') throw new Error(t('worklog.badComment'))
                          await saveActivity(activity, { comment: trimmed })
                        }}
                      />
                      {activity.coveredBy !== null && (
                        <div style={{ color: FG_FAINT, fontSize: 11, marginTop: 1 }}>
                          {t('worklog.lockedBy', { id: activity.coveredBy })}
                        </div>
                      )}
                    </td>
                    <td style={{ ...recordCell, width: 90, textAlign: 'right', whiteSpace: 'nowrap', color: FG_FAINT }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        <span>{activity.turn !== null ? `turn ${activity.turn}` : ''}</span>
                        {activity.editable && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            title={t('worklog.removeRecord')}
                            onClick={() => { void removeActivity(activity) }}
                          >
                            ×
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DisclosureRow>
        </>
      )}

      {notice !== null && (
        <div
          role="status"
          style={{
            marginTop: 12,
            fontSize: 12,
            color: notice.tone === 'ok' ? 'var(--dsw-alias-label-success, #36b37e)' : 'var(--dsw-alias-label-danger, #de350b)',
          }}
        >
          {notice.text}
        </div>
      )}

      <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${BORDER_SOFT}`, color: FG_FAINT, fontSize: 12, lineHeight: '18px' }}>
        {t('worklog.hint')}
      </div>
    </div>
  )
}

/** The raw-record rows are denser than the worklog table. */
const recordCell: React.CSSProperties = {
  padding: '4px 8px',
  verticalAlign: 'middle',
}
