/**
 * sc-jira CLIENT apply. Registers:
 *   - locale dictionary (zh-CN + en-US) — namespace 'scjira'
 *   - Configuration card (slot 'plugins.bundle.config', key '@ian/sc-jira')
 *     that appears on the bundle's own page under 插件 → 已安装插件
 *   - Conversation view (slot 'conversation.view', id 'sc-jira') that appears as
 *     a tab next to Trajectory, with 4 sub-tabs: 本次 Worklog / 我的未完成 /
 *     Worklog 周报 / Issue 详情
 *   - Ticket chip (slot 'conversation.composer.dock', id 'sc-jira-ticket') in the
 *     strip under the composer: the ticket this session is bound to
 *
 * The view names its session so the worklog panel can read that session's
 * document; the card and the view are otherwise pure renderers.
 *
 * All registrations are idempotent: locale uses try/catch per spec §6.5;
 * slots.register is effect-wrapped for dispose.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ScjiraSettingsCard } from './ScjiraSettingsCard.js'
import { ScjiraView } from './ScjiraView.js'
import { TicketChip } from './TicketChip.js'
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

  // 3. The bound ticket, in the strip under the composer.
  //
  // The strip already carries the session's turn and token counters, so it is
  // the one place near the input box where a standing fact about this session
  // belongs. The chip renders nothing while the session is unbound.
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: 'sc-jira-ticket',
        order: -1,  // before the harness's own counters
        locale: NS,
        inject: (sessionId: string) => ({ t: ctx.locale.bind(NS), sessionId }),
      },
      TicketChip as never,
    ),
  )

  // 4. Conversation view — sits next to Trajectory in the view ring
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
}
