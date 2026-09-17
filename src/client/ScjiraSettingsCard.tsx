import * as React from 'react'

interface PropsRuntime {
  t: (key: string) => string
}

export type ScjiraSettingsCardProps = PropsRuntime

interface DescriptorValue {
  server: string
  login: string
  displayName: string
  token: string  // redacted — usually empty string in describe result
}

interface DescriptorResponse {
  descriptors: Array<{
    ns: string
    schema: any
    value: DescriptorValue
    user?: DescriptorValue
    revision: number
  }>
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 6,
  background: 'var(--dsh-input-bg, #111)',
  color: 'var(--dsh-fg, #fff)',
  border: '1px solid var(--dsh-border, #333)',
  borderRadius: 4,
}

export function ScjiraSettingsCard({ t }: ScjiraSettingsCardProps): React.ReactElement {
  const [data, setData] = React.useState<DescriptorValue | null>(null)
  const [revision, setRevision] = React.useState<number>(0)
  const [server, setServer] = React.useState('')
  const [login, setLogin] = React.useState('')
  const [token, setToken] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const busyRef = React.useRef(false)
  const [, setBusy] = React.useState(false)

  async function loadInto(setter: (d: DescriptorValue, rev: number) => void) {
    try {
      const r = await fetch('/api/settings/describe', { credentials: 'include' })
      const body: DescriptorResponse = await r.json()
      const d = body.descriptors?.find(x => x.ns === 'scjira')
      if (d) setter(d.value, d.revision)
    } catch (err) {
      setError(String(err))
    }
  }

  React.useEffect(() => {
    let aborted = false
    loadInto((value, rev) => {
      if (aborted) return
      setData(value)
      setRevision(rev)
      setServer(value.server ?? '')
      setLogin(value.login ?? '')
      setDisplayName(value.displayName ?? '')
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
      // Use path ops so we don't accidentally clobber the redacted token field
      const ops: any[] = []
      ops.push({ op: 'set', path: ['server'], value: server })
      ops.push({ op: 'set', path: ['login'], value: login })
      ops.push({ op: 'set', path: ['displayName'], value: displayName })
      if (token) ops.push({ op: 'set', path: ['token'], value: token })
      const r = await fetch('/api/settings/mutate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ns: 'scjira', ops, expectedRevision: revision }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setSaved(true)
      setToken('')
      // Refresh after save — component still mounted; no abort needed
      await loadInto((value, rev) => {
        setData(value)
        setRevision(rev)
        setServer(value.server ?? '')
        setLogin(value.login ?? '')
        setDisplayName(value.displayName ?? '')
      })
    } catch (err) {
      setError(String(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, color: 'var(--dsh-fg, #fff)' }}>
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
            placeholder={data?.token === '' ? '(unchanged)' : ''}
            style={inputStyle}
          />
        </label>
        <div>
          <button
            onClick={save}
            disabled={busyRef.current}
            style={{
              padding: '6px 16px',
              background: 'var(--dsh-accent, #4af)',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {t('settings.save')}
          </button>
          {saved && <span style={{ marginLeft: 8, color: 'var(--dsh-success, #4f4)' }}>✓</span>}
          {error && <span style={{ marginLeft: 8, color: 'var(--dsh-error, #f55)' }}>{error}</span>}
        </div>
      </div>
    </div>
  )
}
