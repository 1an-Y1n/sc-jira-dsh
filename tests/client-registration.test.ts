import { describe, it, expect, vi } from 'vitest'

// The primitives package ships its components next to stylesheets, which
// Node's ESM loader cannot import. The card only needs the chevron, so the
// package is stubbed: this suite is about WHERE the card is registered, not
// about how a glyph is drawn.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}))

const { apply } = await import('../src/client/index.js')

// Where the configuration card lives is a design decision, so it is pinned:
// the card sits in the Plugins section's configurable tab, keyed by the
// settings namespace the Host registers — not in a settings section of its
// own, which the harness would label with a generic gear.

function makeContext() {
  const registrations: any[] = []
  const injections: Array<{ name: string; factory: () => unknown }> = []
  const localeNamespaces: string[] = []

  const ctx: any = {
    locale: {
      register: (ns: string) => { localeNamespaces.push(ns) },
      bind: (_ns: string) => (key: string) => key,
    },
    slots: {
      // The real slot service defers the factory until the slot is declared;
      // the test keeps the factory and runs it on demand.
      inject: (name: string, factory: () => unknown) => { injections.push({ name, factory }) },
      register: (options: any) => {
        registrations.push(options)
        return () => {}
      },
    },
    // No command surface: the picker is optional, and a host without it must
    // not change what this plugin registers.
    get: () => undefined,
    effect: (fn: () => unknown) => fn(),
  }

  return { ctx, registrations, injections, localeNamespaces }
}

describe('sc-jira client apply', () => {
  it('registers the configuration card as a plugin item, keyed by its namespace', () => {
    const { ctx, registrations, injections } = makeContext()
    apply(ctx)

    const card = injections.find(entry => entry.name === 'settings.plugin.item')
    expect(card).toBeDefined()
    card!.factory()

    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({
      name: 'settings.plugin.item',
      key: 'scjira',
      locale: 'scjira',
    })
  })

  it('registers no settings section of its own', () => {
    const { ctx, injections } = makeContext()
    apply(ctx)
    expect(injections.map(entry => entry.name)).not.toContain('settings.section')
  })

  it('still registers the conversation view', () => {
    const { ctx, injections } = makeContext()
    apply(ctx)
    expect(injections.map(entry => entry.name)).toContain('conversation.view')
  })

  it('registers the locale dictionary under its own namespace', () => {
    const { ctx, localeNamespaces } = makeContext()
    apply(ctx)
    expect(localeNamespaces).toContain('scjira')
  })
})
