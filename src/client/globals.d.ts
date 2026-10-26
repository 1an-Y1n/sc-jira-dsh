/**
 * Ambient declarations for the browser client bundle.
 *
 * The DSH client services (locale, slots, sessions) are provided at runtime
 * by the host's frozen platform module table. The npm packages we depend on
 * only ship types for the bare `Context` shape, so we declare the slices we
 * use as augmentations here. Keep these signatures in sync with the running
 * DSH host version.
 */
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'

interface LocaleRuntime {
  register(
    ns: string,
    dicts: { zh: Record<string, string>; en: Record<string, string> } | { zh: Record<string, string> },
  ): void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
}

interface SlotsRuntime {
  inject<Name extends string>(
    name: Name,
    factory: () => (() => void) | void,
  ): void
  // Target shape varies per slot name. Settings uses `id`; conversation.view
  // inject may take a sessionId argument.
  register(
    target: {
      name: string
      id?: string
      key?: string
      order?: number
      label?: () => string
      locale?: string
      inject?: (...args: any[]) => unknown
    },
    component: ComponentType<any>,
  ): () => void
}

// `sessions` is a framework-standard service for conversation.view owners.
// We don't need its full shape — just enough to satisfy the inject array.
interface SessionsRuntime {
  binding(sessionId: string): unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    locale: LocaleRuntime
    slots: SlotsRuntime
    sessions: SessionsRuntime
  }
}