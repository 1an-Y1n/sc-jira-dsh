import * as React from 'react'

interface BindPanelProps {
  t: (key: string) => string
}

export function BindPanel({ t }: BindPanelProps): React.ReactElement {
  const [key, setKey] = React.useState('')
  const [binding, setBinding] = React.useState<{ bound: boolean; key?: string; summary?: string } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const busyRef = React.useRef(false)
  const [, setBusy] = React.useState(false)  // keep for re-render only

  // sessionId comes from a global injected by host; fall back to placeholder
  const sessionId = (window as any).__DSH_CURRENT_SESSION_ID__ ?? 'unknown'

  React.useEffect(() => {
    let aborted = false
    async function load() {
      try {
        const r = await fetch(`/api/scjira/get-binding?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'include' })
        const body = await r.json()
        if (!aborted) setBinding({ bound: body.bound, key: body.key, summary: body.summary })
      } catch (err) {
        if (!aborted) setError(String(err))
      }
    }
    load()
    return () => { aborted = true }
  }, [])

  async function submit() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/scjira/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sessionId, taskKey: key }),
      })
      const body = await r.json()
      if (body.ok) {
        // Refresh inline (no abort flag for post-submit; component should still be mounted)
        const r2 = await fetch(`/api/scjira/get-binding?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'include' })
        const body2 = await r2.json()
        setBinding({ bound: body2.bound, key: body2.key, summary: body2.summary })
        setKey('')
      } else {
        setError(body.error ?? 'bind failed')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div>
      {binding?.bound && (
        <div style={{
          padding: 8,
          background: 'var(--dsh-success-bg, #143)',
          borderRadius: 4,
          marginBottom: 8,
        }}>
          Bound to <strong>{binding.key}</strong>: {binding.summary}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          type="text"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder={t('bind.placeholder')}
          style={{ flex: 1, padding: 4, background: 'var(--dsh-input-bg, #111)', color: 'var(--dsh-fg, #fff)', border: '1px solid var(--dsh-border, #333)' }}
        />
        <button
          onClick={submit}
          disabled={!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)}
          style={{ padding: '4px 12px', background: 'var(--dsh-accent, #4af)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
        >
          {t('bind.btn')}
        </button>
      </div>
      {error && <div style={{ color: 'var(--dsh-error, #f55)', marginTop: 4, fontSize: 12 }}>{error}</div>}
    </div>
  )
}
