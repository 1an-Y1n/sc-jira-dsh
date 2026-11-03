/**
 * The Jira configuration card.
 *
 * It lives in the Plugins section's configurable tab — `settings.plugin.item`,
 * keyed by the `scjira` settings namespace the Host registers — so it sits
 * beside the Bash and Agent Loop cards and inherits their geometry: the same
 * disclosure card, the same field rhythm, the same footer. Nothing here is
 * styled by hand-picked colours: every rule resolves through a `--dsw-alias-*`
 * token, so the card follows the theme instead of fighting it.
 *
 * The values live in the Host's `scjira` settings namespace. This card reads
 * them back through the plugin's own status route and writes them through its
 * config route, which keeps the secret handling (a blank token never clears
 * the stored one) in one place — the Host.
 */
import * as React from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { JiraLogo } from './JiraLogo.js'
import { EMPTY, isDirty, toDraft, type Draft, type StatusResponse } from './draft.js'
import { ensureStyles } from './styles.js'

/** The locale face the card renders its copy through. */
export interface ScjiraSettingsCardProps {
  t: (key: string) => string
}

/** One labelled field with its hint and an optional state badge. */
function Field(props: {
  id: string
  label: string
  hint: string
  badge?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="scjira-field">
      <div className="scjira-head">
        <label className="scjira-label" htmlFor={props.id}>{props.label}</label>
        {props.badge}
      </div>
      {props.children}
      <p className="scjira-hint">{props.hint}</p>
    </div>
  )
}

/**
 * Render the Jira configuration card.
 *
 * The card opens empty and loads the current configuration on mount; the
 * Host's answer is the baseline the dirty check compares against, so a
 * reload never looks like an unsaved edit.
 * @param props - the locale face.
 * @returns the card element.
 */
export function ScjiraSettingsCard({ t }: ScjiraSettingsCardProps): React.ReactElement {
  ensureStyles()

  const [open, setOpen] = React.useState(false)
  const [baseline, setBaseline] = React.useState<Draft | null>(null)
  const [draft, setDraft] = React.useState<Draft>(EMPTY)
  const [configured, setConfigured] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'failed'; text: string } | null>(null)

  // The current configuration, read once per mount. The token is never part
  // of the answer — the Host redacts it — so the field starts blank.
  React.useEffect(() => {
    let aborted = false
    fetch('/api/scjira/status', { credentials: 'include' })
      .then(r => r.json() as Promise<StatusResponse>)
      .then(body => {
        if (aborted || body.ok === false) return
        const value = toDraft(body)
        setBaseline(value)
        setDraft(value)
        setConfigured(body.configured === true)
      })
      .catch(() => {
        // A failed read leaves the fields empty: the user can still type a
        // full configuration and save it.
      })
    return () => { aborted = true }
  }, [])

  const dirty = isDirty(draft, baseline)

  function edit<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft(previous => ({ ...previous, [key]: value }))
    setNotice(null)
  }

  function discard(): void {
    if (baseline === null) return
    setDraft({ ...baseline, token: '' })
    setNotice(null)
  }

  async function save(): Promise<void> {
    if (saving || !dirty) return
    setSaving(true)
    setNotice(null)
    try {
      const response = await fetch('/api/scjira/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          server: draft.server,
          login: draft.login,
          displayName: draft.displayName,
          proxy: draft.proxy,
          scopeMode: draft.scopeMode,
          token: draft.token,
        }),
      })
      const body = await response.json().catch(() => ({}) as StatusResponse)
      if (!response.ok || body.ok === false) {
        throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`)
      }
      const value = toDraft(body)
      setBaseline(value)
      setDraft({ ...value, token: '' })
      setNotice({ tone: 'ok', text: t('settings.saved') })
    } catch (err) {
      setNotice({ tone: 'failed', text: `${t('settings.saveFailed')}: ${(err as Error).message}` })
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className={open ? 'scjira-card scjira-cardOpen' : 'scjira-card'}>
      <button
        type="button"
        className="scjira-header"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span className="scjira-mark"><JiraLogo size={20} /></span>
        <span className="scjira-headText">
          <span className="scjira-name">{t('settings.card.name')}</span>
          <span className="scjira-description">{t('settings.card.description')}</span>
        </span>
        <IconChevronDownOutline14
          className={open ? 'scjira-chevron scjira-chevronOpen' : 'scjira-chevron'}
          size={14}
        />
      </button>
      {open ? (
        <div className="scjira-body">
          <Field
            id="scjira-server"
            label={t('settings.server')}
            hint={t('settings.serverHint')}
          >
            <input
              id="scjira-server"
              className="scjira-input"
              type="text"
              value={draft.server}
              onChange={e => { edit('server', e.target.value) }}
            />
          </Field>

          <Field
            id="scjira-login"
            label={t('settings.login')}
            hint={t('settings.loginHint')}
          >
            <input
              id="scjira-login"
              className="scjira-input"
              type="text"
              value={draft.login}
              onChange={e => { edit('login', e.target.value) }}
            />
          </Field>

          <Field
            id="scjira-display-name"
            label={t('settings.displayName')}
            hint={t('settings.displayNameHint')}
          >
            <input
              id="scjira-display-name"
              className="scjira-input"
              type="text"
              value={draft.displayName}
              onChange={e => { edit('displayName', e.target.value) }}
            />
          </Field>

          <Field
            id="scjira-token"
            label={t('settings.token')}
            hint={t('settings.tokenHint')}
            badge={(
              <span className={configured ? 'scjira-badge' : 'scjira-badgeMuted'}>
                {configured ? t('settings.tokenConfigured') : t('settings.tokenMissing')}
              </span>
            )}
          >
            <input
              id="scjira-token"
              className="scjira-input"
              type="password"
              autoComplete="off"
              value={draft.token}
              placeholder={t('settings.tokenUnchanged')}
              onChange={e => { edit('token', e.target.value) }}
            />
          </Field>

          <Field
            id="scjira-proxy"
            label={t('settings.proxy')}
            hint={t('settings.proxyHint')}
          >
            <input
              id="scjira-proxy"
              className="scjira-input"
              type="text"
              value={draft.proxy}
              placeholder={t('settings.proxyUnset')}
              onChange={e => { edit('proxy', e.target.value) }}
            />
          </Field>

          <Field
            id="scjira-scope-mode"
            label={t('settings.scopeMode')}
            hint={t('settings.scopeModeHint')}
          >
            <select
              id="scjira-scope-mode"
              className="scjira-input scjira-select"
              value={draft.scopeMode}
              onChange={e => { edit('scopeMode', e.target.value === 'narrow' ? 'narrow' : 'advisory') }}
            >
              <option value="advisory">{t('settings.scopeModeAdvisory')}</option>
              <option value="narrow">{t('settings.scopeModeNarrow')}</option>
            </select>
          </Field>

          <div className="scjira-footer">
            {notice !== null ? (
              <p
                className={notice.tone === 'ok' ? 'scjira-status scjira-statusOk' : 'scjira-status scjira-statusFailed'}
                role="status"
              >
                {notice.text}
              </p>
            ) : <p className="scjira-status" />}
            <button
              type="button"
              className="scjira-discard"
              disabled={!dirty || saving}
              onClick={discard}
            >
              {t('settings.discard')}
            </button>
            <button
              type="button"
              className="scjira-save"
              disabled={!dirty || saving}
              onClick={() => { void save() }}
            >
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
