/**
 * ScjiraView — the conversation.view entry surfaced next to Trajectory.
 * Renders three sub-tabs:
 *   - 本次 Worklog: the session's own round (bind / record / generate / upload)
 *   - Worklog 周报:  GET /api/scjira/list-worklog-week
 *   - Issue 详情:    GET /api/scjira/issue?key=…
 *
 * `t` and `sessionId` arrive from the locale inject face; the view only needs
 * the session to name whose worklog document it reads.
 */
import * as React from 'react'
import { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DayTotal } from '../types.js'
import { addDays, mondayOf, todayIso } from '../timezone.js'
import {
  ACCENT,
  ACCENT_BAR,
  ACCENT_STRONG,
  BORDER,
  BORDER_SOFT,
  FG,
  FG_FAINT,
  FG_MUTED,
  INPUT_BG,
  browseUrl,
  cardStyle,
  fmtInstant,
  fmtSeconds,
  ghostButtonStyle,
  inputStyle,
  primaryButtonStyle,
  tabBarStyle,
  tabBtn,
  tableStyle,
  tdStyle,
  thStyle,
} from './theme.js'
import { WorklogPanel } from './WorklogPanel.js'

interface ScjiraViewProps {
  t: (key: string, params?: Record<string, string | number>) => string
  sessionId: string
}

type SubTab = 'session' | 'week' | 'issue'

interface WorklogWeekResponse {
  ok: boolean
  weekStart?: string
  weekEnd?: string
  dayLabels?: Array<{ date: string; label: string; seconds: number }>
  dailyTotals?: Record<string, DayTotal>
  grandTotalSeconds?: number
  jql?: string
  error?: string
}

/** One comment, as the Host returns it. */
interface IssueComment {
  id: string
  author: string
  created: string
  updated: string
  body: string
}

/** One issue with its comments, as the Host returns it. */
interface IssueDetail {
  key: string
  summary: string
  description: string
  statusName: string
  priority: string
  assignee: string
  duedate: string
  url: string
  comments: IssueComment[]
  commentError?: string
}

interface IssueResponse {
  ok: boolean
  issue?: IssueDetail
  error?: string
}

interface ScjiraRuntime {
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>
}

const RUNTIME_KEY = '__scjiraRuntime__'
declare global { interface Window { [RUNTIME_KEY]?: ScjiraRuntime } }

// Fallback fetch if host didn't expose a runtime helper
async function defaultFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'include', ...init })
  return (await r.json()) as T
}

// Inject once: keyframes for the "Updating…" pulse dot. Idempotent guard so
// hot reloads / repeated mounts don't append duplicate <style> tags.
let pulseStyleInjected = false
function injectPulseKeyframes(): void {
  if (pulseStyleInjected || typeof document === 'undefined') return
  pulseStyleInjected = true
  const el = document.createElement('style')
  el.setAttribute('data-scjira-pulse', '')
  el.textContent = '@keyframes scjira-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }'
  document.head.appendChild(el)
}

function getRuntime(): ScjiraRuntime {
  if (typeof window !== 'undefined' && window[RUNTIME_KEY]) return window[RUNTIME_KEY]!
  return { fetchJson: defaultFetchJson }
}

/**
 * The Jira Server's address, read once per page.
 *
 * The Host owns the configuration, so the week rows carry their own address
 * and this is only the fallback; the issue tab builds its links from the
 * issue rows the Host returns.
 */
let serverAddress: string | null | undefined
let serverAddressPending: Promise<string | null> | null = null

async function jiraServerAddress(fetchJson: ScjiraRuntime['fetchJson']): Promise<string | null> {
  if (serverAddress !== undefined) return serverAddress
  if (serverAddressPending === null) {
    serverAddressPending = fetchJson<{ ok?: boolean; server?: string }>('/api/scjira/status')
      .then(body => {
        serverAddress = body.server ?? null
        return serverAddress
      })
      .catch(() => {
        serverAddress = null
        return null
      })
  }
  return serverAddressPending
}

function WorklogWeekPanel({ t, fetchJson }: { t: ScjiraViewProps['t']; fetchJson: ScjiraRuntime['fetchJson'] }): React.ReactElement {
  const [weekOffset, setWeekOffset] = React.useState(0)
  const [data, setData] = React.useState<WorklogWeekResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [server, setServer] = React.useState<string | null>(null)

  // Compute the Monday of (this week + weekOffset * 7 days).
  // FIX bug-3: week boundaries are resolved in the plugin timezone
  // (Asia/Shanghai) via the shared helpers, not by slicing a UTC timestamp —
  // the UTC date lags the local date by 8 hours.
  const weekStart = React.useMemo(() => {
    injectPulseKeyframes()
    return addDays(mondayOf(todayIso()), weekOffset * 7)
  }, [weekOffset])

  // Anchor for offset arithmetic (today's Monday). Computed once so repeated
  // jumps from the date input don't drift if the user navigates across midnight.
  const currentMonday = React.useMemo(() => mondayOf(todayIso()), [])

  // User picked a date in the input → snap to that week's Monday and rebase
  // weekOffset so the existing useMemo keeps working.
  function jumpToDate(isoDate: string): void {
    const targetMonday = mondayOf(isoDate)
    const diffDays = (Date.parse(targetMonday) - Date.parse(currentMonday)) / 86_400_000
    setWeekOffset(Math.round(diffDays / 7))
  }

  React.useEffect(() => {
    let aborted = false
    setLoading(true)
    void fetchJson<WorklogWeekResponse>(
      `/api/scjira/list-worklog-week?startDate=${weekStart}`,
    ).then(r => {
      if (aborted) return
      setData(r)
      setLoading(false)
    })
    return () => { aborted = true }
  }, [fetchJson, weekStart])

  // The fallback address, for a Host that does not send one with the rows.
  React.useEffect(() => {
    let aborted = false
    void jiraServerAddress(fetchJson).then(address => {
      if (!aborted) setServer(address)
    })
    return () => { aborted = true }
  }, [fetchJson])

  // First fetch only: full-page "加载中…". After that we keep the previous
  // data visible and surface the in-flight state via the small "更新中…" chip
  // — eliminates the loading flash on week navigation.
  if (data === null && loading) {
    return <div style={{ padding: 12, color: FG_MUTED }}>加载中…</div>
  }
  if (!data?.ok) {
    return <div style={{ padding: 12, color: FG_MUTED }}>{data?.error ?? t('error.network')}</div>
  }

  const labels = data.dayLabels ?? []
  const totals = data.dailyTotals ?? {}
  const BAR_PX = 96
  const maxSec = Math.max(1, ...labels.map(l => totals[l.date]?.seconds ?? 0))
  const todayDate = todayIso()

  return (
    <div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12,
        color: FG_MUTED,
        fontSize: 13,
      }}>
        <button
          type="button"
          onClick={() => setWeekOffset(o => o - 1)}
          style={{
            padding: '2px 10px',
            background: 'transparent',
            color: FG,
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            cursor: 'pointer',
            font: 'inherit',
          }}
          title="Previous week"
        >
          ←
        </button>
        <button
          type="button"
          onClick={() => setWeekOffset(0)}
          disabled={weekOffset === 0}
          style={{
            padding: '2px 10px',
            background: weekOffset === 0 ? 'transparent' : INPUT_BG,
            color: FG,
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            cursor: weekOffset === 0 ? 'default' : 'pointer',
            font: 'inherit',
          }}
          title="Jump to current week"
        >
          {weekOffset === 0 ? 'This week' : weekStart}
        </button>
        <button
          type="button"
          onClick={() => setWeekOffset(o => o + 1)}
          style={{
            padding: '2px 10px',
            background: 'transparent',
            color: FG,
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            cursor: 'pointer',
            font: 'inherit',
          }}
          title="Next week"
        >
          →
        </button>
        <input
          type="date"
          value={weekStart}
          onChange={e => { if (e.target.value) jumpToDate(e.target.value) }}
          aria-label="Jump to week containing this date"
          title="Jump to the week containing the picked date"
          style={{
            padding: '2px 6px',
            background: INPUT_BG,
            color: FG,
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            font: 'inherit',
            colorScheme: 'inherit',
          }}
        />
        <span style={{ marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {data.weekStart} ~ {data.weekEnd} · 合计 {fmtSeconds(data.grandTotalSeconds ?? 0)}
          {loading && (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '1px 8px',
              background: INPUT_BG,
              color: FG_MUTED,
              border: `1px solid ${BORDER_SOFT}`,
              borderRadius: 10,
              fontSize: 11,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: ACCENT,
                animation: 'scjira-pulse 1s ease-in-out infinite',
              }} />
              {t('worklog.updating')}
            </span>
          )}
        </span>
      </div>
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 8,
        height: BAR_PX + 28,
        padding: '0 4px 4px',
        marginBottom: 16,
      }}>
        {labels.map(l => {
          const sec = totals[l.date]?.seconds ?? 0
          const heightPx = sec > 0 ? Math.max(4, (sec / maxSec) * BAR_PX) : 0
          const isToday = weekOffset === 0 && l.date === todayDate
          return (
            <div key={l.date} style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              minWidth: 0,
            }}>
              <div style={{ fontSize: 11, color: FG_MUTED, whiteSpace: 'nowrap' }}>
                {fmtSeconds(sec)}
              </div>
              <div style={{
                width: '60%',
                height: BAR_PX,
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
              }}>
                <div style={{
                  width: '100%',
                  height: `${heightPx}px`,
                  background: sec > 0
                    ? (isToday ? ACCENT_STRONG : ACCENT_BAR)
                    : BORDER_SOFT,
                  borderRadius: '3px 3px 0 0',
                  minHeight: 0,
                }} />
              </div>
              <div style={{
                fontSize: 11,
                color: isToday ? ACCENT : FG_MUTED,
                fontWeight: isToday ? 600 : 400,
              }}>
                {l.label}
              </div>
            </div>
          )
        })}
      </div>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>日期</th>
            <th style={thStyle}>Issue</th>
            <th style={thStyle}>Summary</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>用时</th>
          </tr>
        </thead>
        <tbody>
          {labels.flatMap(l =>
            (totals[l.date]?.entries ?? []).map((e, i) => (
              <tr key={`${l.date}-${i}`}>
                <td style={{ ...tdStyle, color: FG_MUTED, whiteSpace: 'nowrap' }}>{l.date}</td>
                <td style={tdStyle}>
                  {/* The issue key opens the issue on the Jira Server. The
                      address comes from the Host, which owns the server
                      configuration — a same-page anchor would just move the
                      DSH page's hash instead. A Host that predates the
                      address falls back to the one the client reads from
                      the status route, so the link is never inert. */}
                  <a
                    href={e.url ?? browseUrl(server, e.issueKey)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: ACCENT_BAR, textDecoration: 'none' }}
                  >
                    {e.issueKey}
                  </a>
                </td>
                <td style={tdStyle}>{e.issueSummary}</td>
                <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtSeconds(e.timeSpentSeconds)}</td>
              </tr>
            )),
          )}
          {labels.every(l => (totals[l.date]?.entries ?? []).length === 0) && (
            <tr>
              <td colSpan={4} style={{ ...tdStyle, color: FG_MUTED }}>{t('status.empty')}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * One issue, read on demand.
 *
 * The key is typed rather than derived from the session: this tab no longer
 * knows (or stores) which issue the conversation is about, so the reader says
 * which one to open. The read is the same `handleIssue` the `jira_issue` tool
 * uses, so the panel and the agent see the same thing.
 */
function IssuePanel({ t, fetchJson }: { t: ScjiraViewProps['t']; fetchJson: ScjiraRuntime['fetchJson'] }): React.ReactElement {
  const [input, setInput] = React.useState('')
  const [data, setData] = React.useState<IssueResponse | null>(null)
  const [loading, setLoading] = React.useState(false)

  async function lookup(key: string): Promise<void> {
    const trimmed = key.trim()
    if (trimmed === '') return
    setLoading(true)
    try {
      const r = await fetchJson<IssueResponse>(`/api/scjira/issue?key=${encodeURIComponent(trimmed)}`)
      setData(r)
    } catch {
      setData({ ok: false, error: t('error.network') })
    } finally {
      setLoading(false)
    }
  }

  const issue = data?.ok === true ? data.issue : undefined

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void lookup(input) }}
          placeholder={t('issue.placeholder')}
          disabled={loading}
          aria-label={t('issue.key')}
          style={{
            flex: 1,
            padding: 6,
            background: INPUT_BG,
            color: FG,
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            font: 'inherit',
          }}
        />
        <button
          type="button"
          onClick={() => { void lookup(input) }}
          disabled={loading || input.trim() === ''}
          style={{
            padding: '6px 16px',
            background: ACCENT,
            color: 'var(--dsw-alias-label-primary)',
            border: 'none',
            borderRadius: 4,
            cursor: loading ? 'default' : 'pointer',
            font: 'inherit',
            fontWeight: 600,
          }}
        >
          {loading ? t('status.loading') : t('issue.lookup')}
        </button>
      </div>

      {data === null && (
        <div style={{ padding: 12, color: FG_MUTED }}>{t('issue.empty')}</div>
      )}
      {data !== null && data.ok !== true && (
        <div style={{ padding: 12, color: FG_MUTED }}>{data.error ?? t('error.network')}</div>
      )}

      {issue !== undefined && (
        <div>
          <div style={{ marginBottom: 8 }}>
            <a
              href={issue.url}
              target="_blank"
              rel="noreferrer"
              style={{ color: ACCENT, fontWeight: 600, textDecoration: 'none', fontSize: 14 }}
            >
              {issue.key}
            </a>
            <span style={{ marginLeft: 8, color: FG, fontWeight: 500 }}>{issue.summary}</span>
          </div>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            marginBottom: 16,
            padding: '8px 10px',
            background: INPUT_BG,
            borderRadius: 4,
            fontSize: 12,
            color: FG_MUTED,
          }}>
            <span>{t('issue.status')}: <strong style={{ color: FG }}>{issue.statusName || '—'}</strong></span>
            <span>{t('issue.priority')}: <strong style={{ color: FG }}>{issue.priority || '—'}</strong></span>
            <span>{t('issue.assignee')}: <strong style={{ color: FG }}>{issue.assignee || '—'}</strong></span>
            <span>{t('issue.duedate')}: <strong style={{ color: FG }}>{issue.duedate || '—'}</strong></span>
          </div>

          <div style={{ marginBottom: 6, color: FG_MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {t('issue.description')}
          </div>
          <div style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: 20,
            padding: '8px 10px',
            background: INPUT_BG,
            borderRadius: 4,
            fontSize: 13,
            lineHeight: '20px',
          }}>
            {issue.description.trim() === '' ? t('issue.noDescription') : issue.description}
          </div>

          <div style={{ marginBottom: 6, color: FG_MUTED, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {t('issue.comments', { count: issue.comments.length })}
          </div>
          {issue.commentError !== undefined && (
            <div style={{ marginBottom: 8, color: FG_FAINT, fontSize: 12 }}>
              {t('issue.commentFailed', { error: issue.commentError })}
            </div>
          )}
          {issue.comments.length === 0
            ? <div style={{ color: FG_MUTED, fontSize: 13 }}>{t('issue.noComments')}</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {issue.comments.map(c => (
                  <div key={c.id} style={{
                    padding: '8px 10px',
                    border: `1px solid ${BORDER_SOFT}`,
                    borderRadius: 4,
                    fontSize: 13,
                  }}>
                    <div style={{ color: FG_MUTED, fontSize: 12, marginBottom: 4 }}>
                      {c.author || '—'} · {fmtInstant(c.created)}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.body}</div>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  )
}

export function ScjiraView({ t, sessionId }: ScjiraViewProps): React.ReactElement {
  const [tab, setTab] = React.useState<SubTab>('session')
  const rt = React.useMemo(getRuntime, [])

  // The tab list comes from the harness's segmented control, so the three
  // views sit in the same control as every other panel in the shell.
  const tabs = [
    { value: 'session' as const, label: t('view.session'), id: 'scjira-tab-session', panelId: 'scjira-panel-session' },
    { value: 'week' as const, label: t('view.week'), id: 'scjira-tab-week', panelId: 'scjira-panel-week' },
    { value: 'issue' as const, label: t('view.issue'), id: 'scjira-tab-issue', panelId: 'scjira-panel-issue' },
  ] as const

  return (
    <div style={cardStyle}>
      {/* Equal-width segments are meant for a bounded row, not the full
          width of a conversation panel: cap it so the three labels read as a
          tab control rather than three large cells. */}
      <div style={{ paddingBottom: 12, maxWidth: 420 }}>
        <SegmentedTabs items={tabs} value={tab} onChange={setTab} label={t('view.label')} />
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {/* All three panels stay mounted across tab switches (hidden, not
            unmounted): the week fetch would flash "加载中…" again, a typed
            issue key would be lost, and the worklog panel would stop noticing
            what the agent just recorded. */}
        <div role="tabpanel" id={tabs[0].panelId} aria-labelledby={tabs[0].id} hidden={tab !== 'session'}>
          <WorklogPanel sessionId={sessionId} t={t} fetchJson={rt.fetchJson} />
        </div>
        <div role="tabpanel" id={tabs[1].panelId} aria-labelledby={tabs[1].id} hidden={tab !== 'week'}>
          <WorklogWeekPanel t={t} fetchJson={rt.fetchJson} />
        </div>
        <div role="tabpanel" id={tabs[2].panelId} aria-labelledby={tabs[2].id} hidden={tab !== 'issue'}>
          <IssuePanel t={t} fetchJson={rt.fetchJson} />
        </div>
      </div>
    </div>
  )
}
