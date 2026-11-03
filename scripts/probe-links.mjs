/**
 * Probe for the issue links in the Jira view.
 *
 * The worklog week table links an issue key; the link has to open the issue
 * ON THE JIRA SERVER. A same-page anchor (`#DZ300-1`) does not: it moves the
 * DSH page's hash and leaves the user where they were — which is the bug
 * this probe pins.
 *
 * It reads the anchors off the DOM and checks each one against the Jira
 * instance: an absolute https URL on the configured server, the /browse/
 * permalink of the key it shows, and a new tab to open it in.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { launchOptions } from './chrome.mjs'

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3092'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/sc-jira-link-probe'

await mkdir(OUT_DIR, { recursive: true })

const browser = await chromium.launch(launchOptions())
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await ctx.newPage()

const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.stack ?? e.message}`))

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2000)

// Enter a session: the view ring belongs to one. A session row in the
// sidebar carries its age ("4分钟"), which tells it apart from the workspace
// rows and from the empty "新会话" — an empty session has no view ring at
// all, so it is the one row that cannot open this panel.
const sessionRow = page.locator('[class*="sessionRow"]')
  .filter({ hasText: /\d+\s*(秒|分钟|小时|天|周|月|年)/ })
  .first()
if (await sessionRow.count()) {
  await sessionRow.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(2500)
}

// The Jira view tab, then its Worklog sub-tab. Both mount asynchronously —
// the view ring appears once the session's views resolve — so the probe waits
// for the tab instead of clicking into the void.
const viewTab = page.locator('[role="tab"]:has-text("Jira")').last()
const viewTabFound = await viewTab.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)
await viewTab.click({ timeout: 8000 }).catch(() => {})
await page.waitForTimeout(2000)

const worklogTab = page.locator('button:has-text("Worklog")').last()
const worklogTabFound = await worklogTab.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)
await worklogTab.click({ timeout: 8000 }).catch(() => {})
await page.waitForTimeout(2000)

/** Every anchor in the visible panel, with the address it points at. */
const readAnchors = () => page.evaluate(() => {
  const out = []
  for (const a of Array.from(document.querySelectorAll('a'))) {
    const text = (a.textContent ?? '').trim()
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(text)) continue
    out.push({
      text,
      href: a.getAttribute('href') ?? '',
      resolved: a.href,
      target: a.getAttribute('target') ?? '',
      rel: a.getAttribute('rel') ?? '',
    })
  }
  return out
})

// The week table arrives from Jira, which is a network round trip per issue:
// poll until the rows are there rather than guessing how long it takes.
let anchors = await readAnchors()
const deadline = Date.now() + 30000
while (anchors.length === 0 && Date.now() < deadline) {
  await page.waitForTimeout(1000)
  anchors = await readAnchors()
}
await page.screenshot({ path: `${OUT_DIR}/01-worklog.png`, fullPage: true })

// The address each link points at must be the issue on the configured
// server — not a fragment of the page the link lives in.
const server = (await (await page.request.get(`${BASE}/api/scjira/status`)).json())?.server ?? ''
const weekLinks = anchors.filter(a => a.href.startsWith('https://') && a.href.includes('/browse/'))
const fragmentLinks = anchors.filter(a => a.href.startsWith('#'))

const allPointToJira = weekLinks.length > 0
  && weekLinks.every(a => {
    const expected = `${server.replace(/\/+$/, '')}/browse/${a.text}`
    return a.resolved === expected && a.target === '_blank'
  })

const report = {
  base: BASE,
  server,
  viewTabFound,
  worklogTabFound,
  anchors,
  weekLinkCount: weekLinks.length,
  fragmentLinkCount: fragmentLinks.length,
  allPointToJira,
  consoleErrors,
}
await writeFile(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

await browser.close()

const pass = allPointToJira && fragmentLinks.length === 0 && consoleErrors.length === 0
process.exit(pass ? 0 : 2)
