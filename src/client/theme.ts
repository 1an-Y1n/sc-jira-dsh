/**
 * The view's shared look: theme-aware tokens, table styles, and the two
 * formatters the panels use.
 *
 * DSH declares the `--dsw-alias-*` custom properties on <body>, so a value
 * here follows whichever theme the user picked (light, dark, or follow-system)
 * without the plugin knowing which one is active. ACCENT stays hardcoded
 * because the harness has no theme-aware link colour; mid-blue reads as a link
 * on both light and dark surfaces.
 */
import type * as React from 'react'

export const PANEL_BG       = 'var(--dsw-alias-bg-base)'
export const FG             = 'var(--dsw-alias-label-primary)'
export const FG_MUTED       = 'var(--dsw-alias-label-secondary)'
export const FG_FAINT       = 'var(--dsw-alias-label-tertiary)'
export const BORDER         = 'var(--dsw-alias-border-l2)'
export const BORDER_SOFT    = 'var(--dsw-alias-border-l1)'
export const INPUT_BG       = 'var(--dsw-alias-bg-overlay)'
export const ACCENT         = '#2684ff'
export const ACCENT_BAR     = '#2684ff'
export const ACCENT_STRONG  = '#4c9aff'
export const SUCCESS        = '#36b37e'
export const ERROR          = '#de350b'

const TAB_ACTIVE_BG = 'var(--dsw-alias-button-ghost-active-fill)'

export const cardStyle: React.CSSProperties = {
  padding: '12px 16px',
  background: PANEL_BG,
  color: FG,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
}

export const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  borderBottom: `1px solid ${BORDER}`,
  marginBottom: 12,
}

export const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  background: active ? TAB_ACTIVE_BG : 'transparent',
  color: active ? ACCENT : FG_MUTED,
  border: 'none',
  borderBottom: active ? `2px solid ${ACCENT}` : '2px solid transparent',
  cursor: 'pointer',
  font: 'inherit',
})

export const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  font: '13px/20px sans-serif',
  color: FG,
}

export const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px 6px',
  color: FG_MUTED,
  fontWeight: 500,
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

export const tdStyle: React.CSSProperties = {
  padding: '10px 10px',
  color: FG,
  verticalAlign: 'top',
  borderBottom: `1px solid ${BORDER_SOFT}`,
}

export const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  background: INPUT_BG,
  color: FG,
  border: `1px solid ${BORDER}`,
  borderRadius: 4,
  font: 'inherit',
}

export const primaryButtonStyle: React.CSSProperties = {
  padding: '6px 14px',
  background: ACCENT,
  color: 'var(--dsw-alias-label-primary)',
  border: 'none',
  borderRadius: 4,
  font: 'inherit',
  fontWeight: 600,
}

export const ghostButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  color: FG,
  border: `1px solid ${BORDER}`,
  borderRadius: 4,
  font: 'inherit',
}

/** `1h 30m` / `45m` / `0s` — the same shape the host reports. */
export function fmtSeconds(total: number): string {
  const s = Math.max(0, Math.round(total))
  if (s === 0) return '0s'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** `2026-11-04T09:10:00.000+0800` → `11-04 09:10`, keeping the wall clock. */
export function fmtInstant(iso: string): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (m === null) return iso
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

/**
 * The browsable address of an issue, built from the server address.
 *
 * The `/browse/<key>` form is Jira Server's own issue permalink; the trailing
 * slashes are trimmed so a configured `https://host/` and `https://host`
 * produce the same link.
 */
export function browseUrl(server: string | null | undefined, key: string | undefined): string | undefined {
  if (server === undefined || server === null || server === '') return undefined
  if (key === undefined || key === '') return undefined
  return `${server.replace(/\/+$/, '')}/browse/${key}`
}
