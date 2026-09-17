/**
 * sc-jira CLIENT apply. Registers:
 *   - locale dictionary (zh-CN + en-US)
 *   - Settings card (settings.section slot)
 *   - Right-sidebar tab type 'scjira' + tab body (sidebar.right.pane.tab slot)
 *
 * All registrations are idempotent: locale uses try/catch per spec §6.5;
 * slots/sidebarRightTabs/register are effect-wrapped for dispose.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createElement as h } from 'react'
import { ScjiraTab } from './ScjiraTab.js'
import { ScjiraSettingsCard } from './ScjiraSettingsCard.js'
import { zh, en } from './locales.js'

export const name = 'sc-jira-client'

export const inject = ['slots']

export function apply(ctx: Context): void {
  // 1. Locale — §6.5 fix: try/catch + single-locale fallback
  try {
    ctx.locale.register('scjira', { zh, en })
  } catch {
    try {
      ctx.locale.register('scjira', { zh })
    } catch {
      // already registered with single locale; safe to ignore
    }
  }

  // 2. Settings card
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'scjira', order: 100 },
      ScjiraSettingsCard,
    ),
  )

  // 3. Sidebar tab type
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: '@ian/sc-jira',
    kind: 'scjira',
    title: () => 'sc-jira',
    guide: {
      order: 200,
      title: () => 'sc-jira',
      description: () => 'Jira issues & worklog & session binding',
    },
  }))

  // 4. Sidebar tab body
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: '@ian/sc-jira' },
      ScjiraTab,
    ),
  )
}
