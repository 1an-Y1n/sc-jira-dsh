/**
 * Ambient declarations for the browser client bundle.
 *
 * The DSH client services (locale, slots) are provided at runtime
 * by the host's frozen platform module table. The npm packages we depend on
 * only ship types for the bare `Context` shape, so we declare the slices we
 * use as augmentations here. Keep these signatures in sync with the running
 * DSH host version.
 */
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'

interface LocaleRuntime {
  /**
   * The single-locale form — the one published for namespaces outside the
   * harness's merge table, which is what ours is. Registers one dictionary
   * under one locale of one namespace; a second registration of the same
   * (namespace, locale) pair throws.
   */
  register(ns: string, locale: string, dict: Record<string, string>): () => void
  /** The all-locales-in-one-call form. */
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
}

/** A list-entry display label: plain text, or a thunk re-read per render. */
type SlotLabel = string | (() => string)

/**
 * The options every registration carries.
 *
 * `name` is the slot it contributes into; `locale` names the dictionary
 * namespace whose translated seat the framework puts on the component props;
 * `inject` supplies the registrant's own business face.
 */
interface SlotEntryOptions {
  name: string
  locale?: string
  registrant?: string
  inject?: (...args: any[]) => unknown
}

/**
 * A keyed slot: one cell per key. `priority` ranks the cell's occupants —
 * the lowest live one renders, so a second registration at the same priority
 * throws.
 */
interface KeyedSlotOptions extends SlotEntryOptions {
  key: string
  priority?: number
}

/**
 * A list slot: one cell per id. `order` is the display order, `label` the
 * entry's name in the list.
 */
interface ListSlotOptions extends SlotEntryOptions {
  id: string
  order?: number
  label?: SlotLabel
  priority?: number
}

interface SlotsRuntime {
  inject<Name extends string>(
    name: Name,
    factory: () => (() => void) | void,
  ): void
  /**
   * Contribute a component to a slot.
   *
   * The target shape follows the slot's cardinality: a keyed slot takes
   * `key`, a list slot takes `id` (plus `order` and `label`), and a
   * conversation view's inject may take a sessionId argument.
   */
  register(
    target: KeyedSlotOptions | ListSlotOptions,
    component: ComponentType<any>,
  ): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    locale: LocaleRuntime
    slots: SlotsRuntime
  }
}
