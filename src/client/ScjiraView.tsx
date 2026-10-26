/**
 * ScjiraView — the conversation.view entry surfaced next to Trajectory.
 * Renders three sub-tabs:
 *   - 我的未完成: GET /api/scjira/list-my-open
 *   - Worklog 周报: GET /api/scjira/list-worklog-week
 *   - 绑定 Session: GET /api/scjira/get-binding (uses current sessionId)
 *
 * Component receives framework-standard props (sessionId, useSession) plus
 * `t` from the locale inject face. Renders nothing while a request is in
 * flight; surfaces a hint when credentials are missing.
 */
import * as React from 'react'
import type { IssueSummary, DayTotal } from '../types.js'
import { addDays, mondayOf, todayIso } from '../timezone.js'

interface ScjiraViewProps {
  sessionId: string
  t: (key: string) => string
}

type SubTab = 'open' | 'worklog' | 'bind'

interface ListOpenResponse {
  ok: boolean
  issues?: IssueSummary[]
  totalSpentSeconds?: number
  jql?: string
  error?: string
}

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

interface GetBindingResponse {
  ok: boolean
  bound: boolean
  key?: string
  summary?: string
  sessionId?: string
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

// Color tokens — white text on dark background (Atlassian dark-theme palette).
// User requested: keep background unchanged, use white text. The DSH card
// background is dark (in this user's theme); we therefore render FG in pure
// white and shift accents/borders to dark-theme variants so they remain
// readable on top of it.
// Color tokens — use DSH's own theme-aware CSS custom properties so the
// panel automatically matches whichever theme the user has selected (light,
// dark, or "follow system"). DSH declares these on <body>; because CSS
// variables cascade, the values resolve correctly inside any React subtree.
//
// Probed via scripts/inspect-bg.mjs:
//   --dsw-alias-bg-base          : #fff (light)  / dark in dark
//   --dsw-alias-bg-overlay       : #e9ecf2 (light) / tinted dark in dark
//   --dsw-alias-label-primary    : #0f1115 (light) / near-white in dark
//   --dsw-alias-label-secondary  : #61666b (light) / muted in dark
//   --dsw-alias-label-tertiary   : #81858c (light) / faint in dark
//   --dsw-alias-label-caption    : #adb2b8 (light) / faint in dark
//   --dsw-alias-border-l1..l4    : rgba(0,0,0,X) — works on both via overlay
//   --dsw-alias-button-ghost-active-fill : #ebeef2 (light) / tinted in dark
// ACCENT stays hardcoded (DSH has no theme-aware link color); mid-blue
// `#2684ff` reads as a link on both light and dark surfaces.
const PANEL_BG       = 'var(--dsw-alias-bg-base)'
const FG             = 'var(--dsw-alias-label-primary)'
const FG_MUTED       = 'var(--dsw-alias-label-secondary)'
const FG_FAINT       = 'var(--dsw-alias-label-tertiary)'
const BORDER         = 'var(--dsw-alias-border-l2)'
const BORDER_SOFT    = 'var(--dsw-alias-border-l1)'
const INPUT_BG       = 'var(--dsw-alias-bg-overlay)'
const ACCENT         = '#2684ff'
const ACCENT_BAR     = '#2684ff'
const ACCENT_STRONG  = '#4c9aff'
const SUCCESS        = '#36b37e'
const ERROR          = '#de350b'

const cardStyle: React.CSSProperties = {
  padding: '12px 16px',
  background: PANEL_BG,
  color: FG,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
}

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  borderBottom: `1px solid ${BORDER}`,
  marginBottom: 12,
}

const TAB_ACTIVE_BG = 'var(--dsw-alias-button-ghost-active-fill)'

const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  background: active ? TAB_ACTIVE_BG : 'transparent',
  color: active ? ACCENT : FG_MUTED,
  border: 'none',
  borderBottom: active ? `2px solid ${ACCENT}` : '2px solid transparent',
  cursor: 'pointer',
  font: 'inherit',
})

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  font: '13px/20px sans-serif',
  color: FG,
}
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px 6px',
  color: FG_MUTED,
  fontWeight: 500,
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}
const tdStyle: React.CSSProperties = {
  padding: '10px 10px',
  color: FG,
  verticalAlign: 'top',
  borderBottom: `1px solid ${BORDER_SOFT}`,
}

function fmtSeconds(s: number): string {
  if (!s || s <= 0) return '0s'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function LoadingRow({ colSpan }: { colSpan: number }): React.ReactElement {
  return (
    <tr>
      <td colSpan={colSpan} style={{ ...tdStyle, color: FG_MUTED }}>
        加载中…
      </td>
    </tr>
  )
}

function ErrorRow({ colSpan, message }: { colSpan: number; message: string }): React.ReactElement {
  return (
    <tr>
      <td colSpan={colSpan} style={{ ...tdStyle, color: ERROR }}>
        {message}
      </td>
    </tr>
  )
}

function ListMyOpenPanel({ t, fetchJson }: { t: ScjiraViewProps['t']; fetchJson: ScjiraRuntime['fetchJson'] }): React.ReactElement {
  const [data, setData] = React.useState<ListOpenResponse | null>(null)
  const [loading, setLoading] = React.useState(true)

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetchJson<ListOpenResponse>('/api/scjira/list-my-open')
      setData(r)
    } finally {
      setLoading(false)
    }
  }, [fetchJson])

  React.useEffect(() => { void reload() }, [reload])

  if (loading) return <LoadingRow colSpan={6} />
  if (!data?.ok) {
    return (
      <div style={{ padding: 12, color: FG_MUTED }}>
        {data?.error ?? t('error.network')}
      </div>
    )
  }
  const issues = data.issues ?? []
  if (issues.length === 0) {
    return <div style={{ padding: 12, color: FG_MUTED }}>{t('status.empty')}</div>
  }
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>Key</th>
          <th style={thStyle}>Summary</th>
          <th style={thStyle}>Status</th>
          <th style={thStyle}>Priority</th>
          <th style={thStyle}>Due</th>
          <th style={thStyle}>Spent</th>
        </tr>
      </thead>
      <tbody>
        {issues.map((iss) => (
          <tr key={iss.key}>
            <td style={tdStyle}>
              <a href={iss.url} target="_blank" rel="noreferrer" style={{ color: ACCENT, fontWeight: 500 }}>
                {iss.key}
              </a>
            </td>
            <td style={tdStyle}>{iss.summary}</td>
            <td style={tdStyle}>{iss.statusName}</td>
            <td style={tdStyle}>{iss.priority}</td>
            <td style={tdStyle}>
              {iss.duedate ? iss.duedate : <span style={{ color: FG_FAINT }}>—</span>}
            </td>
            <td style={tdStyle}>{fmtSeconds(iss.timeSpentSeconds)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function WorklogWeekPanel({ t, fetchJson }: { t: ScjiraViewProps['t']; fetchJson: ScjiraRuntime['fetchJson'] }): React.ReactElement {
  const [weekOffset, setWeekOffset] = React.useState(0)
  const [data, setData] = React.useState<WorklogWeekResponse | null>(null)
  const [loading, setLoading] = React.useState(true)

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
                  <a href={`#${e.issueKey}`} style={{ color: ACCENT_BAR, textDecoration: 'none' }}>
                    {e.issueKey}
                  </a>
                </td>
                <td style={tdStyle}>{e.issueSummary}</td>
                <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtSeconds(e.timeSpentSeconds)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  )
}

function BindPanel({ sessionId, t, fetchJson }: { sessionId: string; t: ScjiraViewProps['t']; fetchJson: ScjiraRuntime['fetchJson'] }): React.ReactElement {
  const [data, setData] = React.useState<GetBindingResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [input, setInput] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetchJson<GetBindingResponse>(`/api/scjira/get-binding?sessionId=${encodeURIComponent(sessionId)}`)
      setData(r)
    } finally {
      setLoading(false)
    }
  }, [fetchJson, sessionId])

  React.useEffect(() => { void reload() }, [reload])

  async function bind() {
    if (!input.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await fetchJson<{ ok: boolean; error?: string; key?: string }>('/api/scjira/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, taskKey: input.trim() }),
      })
      if (r.ok) {
        setMsg(`${t('bind.success')} → ${r.key ?? input}`)
        setInput('')
        await reload()
      } else {
        setMsg(r.error ?? 'failed')
      }
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div style={{ padding: 12, color: FG_MUTED }}>加载中…</div>

  return (
    <div>
      <div style={{
        marginBottom: 12,
        padding: '8px 10px',
        background: INPUT_BG,
        borderRadius: 4,
      }}>
        {data?.bound
          ? <span>当前 session 绑定到 <strong>{data.key}</strong> · {data.summary}</span>
          : <span style={{ color: FG_MUTED }}>当前 session 未绑定</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={t('bind.placeholder')}
          disabled={busy}
          style={{
            flex: 1,
            padding: 6,
            background: INPUT_BG,
            color: FG,
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
          }}
        />
        <button
          onClick={bind}
          disabled={busy || !input.trim()}
          style={{
            padding: '6px 16px',
            background: ACCENT,
            color: 'var(--dsw-alias-label-primary)',
            border: 'none',
            borderRadius: 4,
            cursor: busy ? 'default' : 'pointer',
            fontWeight: 600,
          }}
        >
          {t('bind.btn')}
        </button>
      </div>
      {msg && <div style={{ marginTop: 8, color: SUCCESS }}>{msg}</div>}
    </div>
  )
}

export function ScjiraView({ sessionId, t }: ScjiraViewProps): React.ReactElement {
  const [tab, setTab] = React.useState<SubTab>('open')
  const rt = React.useMemo(getRuntime, [])

  return (
    <div style={cardStyle}>
      <div style={tabBarStyle}>
        <button type="button" style={tabBtn(tab === 'open')} onClick={() => setTab('open')}>
          {t('view.open')}
        </button>
        <button type="button" style={tabBtn(tab === 'worklog')} onClick={() => setTab('worklog')}>
          {t('view.worklog')}
        </button>
        <button type="button" style={tabBtn(tab === 'bind')} onClick={() => setTab('bind')}>
          {t('view.bind')}
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {/* All three panels stay mounted across tab switches (display:none
            for inactive). Without this, every tab switch unmounts + remounts
            the panel, which re-fires the useEffect and shows "加载中…" until
            Jira responds. Each panel still only runs its fetch once per
            startDate/weekOffset change, but the user sees no loading on
            switch because the previously-fetched data is already in state. */}
        <div style={{ display: tab === 'open' ? 'block' : 'none' }}>
          <ListMyOpenPanel t={t} fetchJson={rt.fetchJson} />
        </div>
        <div style={{ display: tab === 'worklog' ? 'block' : 'none' }}>
          <WorklogWeekPanel t={t} fetchJson={rt.fetchJson} />
        </div>
        <div style={{ display: tab === 'bind' ? 'block' : 'none' }}>
          <BindPanel sessionId={sessionId} t={t} fetchJson={rt.fetchJson} />
        </div>
      </div>
    </div>
  )
}