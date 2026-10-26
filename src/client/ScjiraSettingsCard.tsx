import * as React from 'react'

interface PropsRuntime {
  t: (key: string) => string
}

export type ScjiraSettingsCardProps = PropsRuntime

interface DescriptorValue {
  server: string
  login: string
  displayName: string
  token: string  // redacted — never echoed by status endpoint
  proxy: string
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 6,
  background: 'var(--dsw-alias-bg-overlay)',
  color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 4,
}

export function ScjiraSettingsCard({ t }: ScjiraSettingsCardProps): React.ReactElement {
  const [data, setData] = React.useState<DescriptorValue | null>(null)
  const [server, setServer] = React.useState('')
  const [login, setLogin] = React.useState('')
  const [token, setToken] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [proxy, setProxy] = React.useState('')
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const busyRef = React.useRef(false)
  const [, setBusy] = React.useState(false)

  // Load current config from host via our own /api/scjira/status endpoint.
  // Token is never echoed (the host redact secrets).
  React.useEffect(() => {
    let aborted = false
    fetch('/api/scjira/status', { credentials: 'include' })
      .then(r => r.json() as Promise<{
        ok: boolean; configured: boolean;
        server?: string; login?: string; displayName?: string; proxy?: string;
      }>)
      .then(body => {
        if (aborted || !body.ok) return
        const value: DescriptorValue = {
          server: body.server ?? '',
          login: body.login ?? '',
          displayName: body.displayName ?? '',
          token: '',
          proxy: body.proxy ?? '',
        }
        setData(value)
        setServer(value.server)
        setLogin(value.login)
        setDisplayName(value.displayName)
        setProxy(value.proxy)
      })
      .catch(() => {
        // Network error: leave fields empty so user can type fresh values.
      })
    return () => { aborted = true }
  }, [])

  async function save() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const r = await fetch('/api/scjira/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ server, login, displayName, token, proxy }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setSaved(true)
      setToken('')
      // Refresh after save
      const body = await r.clone().json().catch(() => null)
      if (body && body.ok) {
        setServer(body.server ?? server)
        setLogin(body.login ?? login)
        setDisplayName(body.displayName ?? displayName)
        setProxy(body.proxy ?? proxy)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)' }}>
      <h3>{t('settings.title')}</h3>
      <div style={{ display: 'grid', gap: 8, maxWidth: 480 }}>
        <label>
          <div>{t('settings.server')}</div>
          <input value={server} onChange={e => setServer(e.target.value)} style={inputStyle} />
        </label>
        <label>
          <div>{t('settings.login')}</div>
          <input value={login} onChange={e => setLogin(e.target.value)} style={inputStyle} />
        </label>
        <label>
          <div>{t('settings.displayName')}</div>
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} style={inputStyle} />
        </label>
        <label>
          <div>{t('settings.token')}</div>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={data && data.login ? '(unchanged)' : t('settings.token')}
            style={inputStyle}
          />
        </label>
        <label>
          <div>{t('settings.proxy')}</div>
          <input
            value={proxy}
            onChange={e => setProxy(e.target.value)}
            placeholder="(optional, e.g. http://127.0.0.1:8888)"
            style={inputStyle}
          />
        </label>
        <div>
          <button
            onClick={save}
            disabled={busyRef.current}
            style={{
              padding: '6px 16px',
              background: '#2684ff',
              color: 'var(--dsw-alias-label-primary)',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {t('settings.save')}
          </button>
          {saved && <span style={{ marginLeft: 8, color: '#36b37e' }}>✓</span>}
          {error && <span style={{ marginLeft: 8, color: '#de350b' }}>{error}</span>}
        </div>
      </div>
    </div>
  )
}
