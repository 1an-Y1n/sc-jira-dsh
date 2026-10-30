/**
 * sc-jira CLIENT apply. Registers:
 *   - locale dictionary (zh-CN + en-US) — namespace 'scjira'
 *   - Settings section card (slot 'settings.section', id 'scjira') for credentials
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
  // 1. Locale — §6.5 fix: try/catch + single-locale fallback
  try {
    ctx.locale.register(NS, { zh, en })
  } catch {
    try {
      ctx.locale.register(NS, { zh })
    } catch {
      // already registered with single locale; safe to ignore
    }
  }

  // 2. Settings section card (credentials + live data)
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'scjira',
        order: 100,
        locale: NS,
        label: () => ctx.locale.bind(NS)('settings.nav'),
        inject: () => ({ t: ctx.locale.bind(NS) }),
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