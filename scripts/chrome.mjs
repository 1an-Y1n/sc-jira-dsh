/**
 * Shared browser-launch helper for the dev probe scripts.
 *
 * Playwright ships its own browser, so the simplest path is to launch with no
 * `executablePath` at all. Some environments (headless CI images, minimal
 * desktops) already have a system Chrome and prefer using it, so we accept an
 * explicit `CHROME_PATH` or probe the usual system locations.
 */
import { existsSync } from 'node:fs'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean)

/**
 * Resolve a Chrome binary to use, or `undefined` to let Playwright pick its
 * own bundled browser.
 */
export function resolveChromePath() {
  return CHROME_CANDIDATES.find(p => existsSync(p))
}

/**
 * Options to spread into `chromium.launch(...)`.
 */
export function launchOptions() {
  const executablePath = resolveChromePath()
  return {
    headless: true,
    ...(executablePath && { executablePath }),
  }
}
