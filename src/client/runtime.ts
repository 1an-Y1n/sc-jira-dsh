/**
 * The shared client runtime: one way to reach the plugin's own routes.
 *
 * The Host may hand the client half a runtime helper (it knows how to talk
 * to the Host without guessing the base URL); when it does not, the browser's
 * own fetch is the fallback. Both paths speak the same JSON shape.
 */

export interface ScjiraRuntime {
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>
}

const RUNTIME_KEY = '__scjiraRuntime__'
declare global { interface Window { [RUNTIME_KEY]?: ScjiraRuntime } }

/** Fallback fetch if the host did not expose a runtime helper. */
export async function defaultFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: 'include', ...init })
  return (await r.json()) as T
}

/** The runtime this page talks through. */
export function getRuntime(): ScjiraRuntime {
  if (typeof window !== 'undefined' && window[RUNTIME_KEY]) return window[RUNTIME_KEY]!
  return { fetchJson: defaultFetchJson }
}
