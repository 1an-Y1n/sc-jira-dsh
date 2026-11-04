import { describe, it, expect, vi } from 'vitest'

// The primitives package ships its components next to stylesheets, which
// Node's ESM loader cannot import. The card only needs the chevron, so the
// package is stubbed: this suite is about WHERE the card is registered, not
// about how a glyph is drawn.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineRegular: () => null,
}))

const { apply } = await import('../src/client/index.js')

// Where the configuration card lives is a design decision, so it is pinned:
// the card sits on the bundle's own page in the plugin manager, keyed by the
// bundle's package name — not in a settings section of its own, which the
// harness would label with a generic gear.

function makeContext() {
  const registrations: any[] = []
  const injections: Array<{ name: string; factory: () => unknown }> = []
  const localeNamespaces: string[] = []
  const localeEntries: Array<{ ns: string; locale: string; keys: string[] }> = []

  const ctx: any = {
    locale: {
      register: (ns: string, locale: string, dict: Record<string, string>) => {
        localeNamespaces.push(ns)
        localeEntries.push({ ns, locale, keys: Object.keys(dict) })
        return () => {}
      },
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

  return { ctx, registrations, injections, localeNamespaces, localeEntries }
}

describe('sc-jira client apply', () => {
  it('registers the configuration card on the bundle page, keyed by the package name', () => {
    const { ctx, registrations, injections } = makeContext()
    apply(ctx)

    const card = injections.find(entry => entry.name === 'plugins.bundle.config')
    expect(card).toBeDefined()
    card!.factory()

    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({
      name: 'plugins.bundle.config',
      key: '@ian/sc-jira',
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

  it('registers every locale with the same keys, so no text is half-translated', () => {
    const { ctx, localeEntries } = makeContext()
    apply(ctx)

    const ours = localeEntries.filter(entry => entry.ns === 'scjira')
    expect(ours.map(entry => entry.locale)).toEqual(['zh', 'en'])
    expect(ours[0].keys).toEqual(ours[1].keys)
  })

  it('survives a client half that loads twice', () => {
    const { ctx } = makeContext()
    // The second registration of the same (namespace, locale) pair throws;
    // the plugin must swallow it rather than take the client down.
    ctx.locale.register = (ns: string, locale: string) => {
      throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
    }
    expect(() => apply(ctx)).not.toThrow()
  })
})
