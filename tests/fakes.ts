import type { ScjiraConfig } from '../src/index.js'

/** A volatile reference that always reads the same value. */
export function volatile<T>(value: T) {
  return { get: () => value }
}

/**
 * The plugin's resolved configuration.
 *
 * In the Host the credential fields are live references the settings card
 * writes through; here they are fixed readings, which is all the routes and
 * the tools need. The plugin stores nothing of its own, so there is no
 * directory to point at.
 */
export function makeConfig(creds: Record<string, string> = {}): ScjiraConfig {
  const value = (key: string, fallback: string) => volatile(creds[key] ?? fallback)
  return {
    server: value('server', 'https://jiratest.example.com'),
    login: value('login', 'A003688'),
    token: value('token', ''),
    displayName: value('displayName', 'Ian Yin'),
    proxy: value('proxy', ''),
  }
}
