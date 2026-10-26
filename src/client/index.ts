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
}