/**
 * sc-jira CLIENT apply. Registers:
 *   - locale dictionary (zh-CN + en-US) — namespace 'scjira'
 *   - Configuration card (slot 'plugins.bundle.config', key '@ian/sc-jira')
 *     that appears on the bundle's own page under 插件 → 已安装插件
 *   - Conversation view (slot 'conversation.view', id 'sc-jira') that appears as
 *     a tab next to Trajectory, with 3 sub-tabs: 我的未完成 / Worklog 周报 / 绑定 Session
 *
 * All registrations are idempotent: locale uses try/catch per spec §6.5;
 * slots.register is effect-wrapped for dispose.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ScjiraSettingsCard } from './ScjiraSettingsCard.js'
import { ScjiraView } from './ScjiraView.js'
import { zh, en } from './locales.js'

export const name = 'sc-jira-client'

export const inject = ['slots', 'locale'] as const

const NS = 'scjira'

/**
 * The bundle's package name.
 *
 * A plugin that lives outside the harness repository is a BUNDLE, and the
 * plugin manager gives it a page of its own. `plugins.bundle.config` is the
 * seat that page reserves for the bundle's configuration, keyed by the
 * bundle's package name — the one name both sides already hold, so the page
 * finds the card without learning what the settings namespace means.
 */
const BUNDLE = '@ian/sc-jira'

/** One row of the picker's list. */
interface SelectOption {
  id: string
  label: string
  detail?: string
  active?: boolean
}

/**
 * The slice of the client command UI this plugin uses.
 *
 * The service belongs to the harness, not to this plugin, so its shape is
 * described here rather than imported: the plugin reads it optionally and
 * keeps working when the host does not provide it.
 */
interface CommandUiFace {
  decorate(decoration: {
    name: string
    available: (session: { sessionId: string }) => boolean
    ui: {
      kind: 'popupSelect'
      options: (session: { sessionId: string }) => Promise<readonly SelectOption[]>
      onSelect: (option: SelectOption, session: { sessionId: string }) => void | Promise<void>
    }
  }): () => void
}

/**
 * The slice of the client remote this plugin uses.
 *
 * `remote.commands` is a service in its OWN right, not a property of the
 * remote registry: reading it as `remote.commands` walks Cordis's guarded
 * property path, and a plugin that has not declared it in `inject` gets
 * "cannot get property ... without inject" — which fails the WHOLE client
 * half, taking the settings card and the view tab down with it. Looking it
 * up by its own key keeps the lookup optional, so a host without the command
 * surface simply has no picker and the rest of the plugin still works.
 */
interface CommandsRemote {
  execute: (
    agentId: string,
    line: string,
    images: readonly unknown[],
    signal?: AbortSignal,
  ) => Promise<{
    ok: boolean
    value?: { result: { kind: string; text?: string } }
    error?: { code: string; message: string }
  }>
}

/** Read a JSON route from the host, with the session cookie attached. */
async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return await res.json() as T
}

export function apply(ctx: Context): void {
  // 1. Locale.
  //
  // The namespace is ours, so it is not in the harness's merge table, and the
  // single-locale form is the one the locale service publishes for namespaces
  // outside it. One call per locale, so a partially registered namespace is
  // still usable: a client half that loads twice throws on the second
  // registration of the same (namespace, locale) pair, and that must not take
  // the card and the view tab down with it.
  for (const [locale, dict] of Object.entries({ zh, en })) {
    try {
      ctx.locale.register(NS, locale, dict)
    } catch {
      // Already registered under this locale — safe to ignore.
    }
  }

  // 2. The configuration card, on the bundle's own page in the plugin manager.
  //
  // DSH gives every plugin that lives OUTSIDE the harness repository a page
  // of its own under 插件 → 已安装插件, and `plugins.bundle.config` is the
  // seat that page reserves for the bundle's configuration. The key is the
  // bundle's package name, so the page finds the card without having to
  // learn what the settings namespace means.
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: BUNDLE,
        locale: NS,
      },
      ScjiraSettingsCard as never,
    ),
  )

  // 3. Conversation view — sits next to Trajectory in the view ring
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'sc-jira',
        order: 20,  // trajectory is order 10; we sit just after it
        locale: NS,
        label: () => ctx.locale.bind(NS)('settings.nav'),
        inject: (sessionId: string) => ({ t: ctx.locale.bind(NS), sessionId }),
      },
      ScjiraView as never,
    ),
  )

  // 4. The /jira-bind picker.
  //
  // The host command binds a session to an issue, and typing the key works.
  // But remembering issue keys is work, so the bare invocation opens a picker
  // of the open issues instead.
  //
  // The picker does not bind anything itself. It submits a completed command
  // line, so the binding goes through the same host command a typed key
  // goes through — one code path, one set of rules, and the session log
  // records the choice the way it records a typed command.
  //
  // Both services are optional. A client without them still shows the panel;
  // it simply has no picker. Neither lookup may take the plugin down: the
  // picker is an extra, not the product.
  const commandUi = ctx.get('commandUi') as CommandUiFace | undefined
  const executeCommand = ctx.get('remote.commands') as CommandsRemote | undefined

  if (commandUi !== undefined && executeCommand !== undefined) {
    ctx.effect(() => commandUi.decorate({
      name: 'jira-bind',
      available: () => true,
      ui: {
        kind: 'popupSelect',
        options: async (session) => {
          const data = await fetchJson<{
            ok?: boolean
            issues?: Array<{ key: string; summary: string; statusName?: string }>
            error?: string
          }>('/api/scjira/open-issues')
          if (data.ok === false) throw new Error(data.error ?? 'could not load the open issues')

          // The already-bound issue is marked, so the picker shows where this
          // session stands rather than only where it could go.
          let currentKey: string | undefined
          try {
            const binding = await fetchJson<{ bound?: boolean; key?: string }>(
              `/api/scjira/get-binding?sessionId=${encodeURIComponent(session.sessionId)}`,
            )
            if (binding.bound === true) currentKey = binding.key
          } catch {
            // A missing binding is not an error — it just means nothing is
            // marked, and the list still works.
          }

          return (data.issues ?? []).map(issue => ({
            id: issue.key,
            label: `${issue.key} — ${issue.summary}`,
            detail: issue.statusName ?? '',
            active: currentKey === issue.key,
          }))
        },
        onSelect: async (option, session) => {
          const result = await executeCommand.execute(session.sessionId, `/jira-bind ${option.id}`, [])
          if (!result.ok) {
            const code = result.error?.code ?? 'unknown'
            const message = result.error?.message ?? ''
            throw new Error(`command.execute failed: ${code}: ${message}`)
          }
          if (result.value?.result.kind === 'error') {
            throw new Error(result.value.result.text ?? 'the bind failed')
          }
        },
      },
    }))
  }
}