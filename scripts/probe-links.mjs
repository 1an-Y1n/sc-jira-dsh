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
 * permalink of the key it shows, and a new tab to open it in. Then it CLICKS
 * one and watches for the tab that opens — a link with no address opens
 * nothing, and a link that opens the wrong page is no better.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
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

// Enter a session: the view ring belongs to one, and only a session that
// has messages renders one — an empty session shows no ring at all. So the
// probe walks the candidate rows (the ones carrying an age, which sets them
// apart from the workspace rows) until one of them opens a ring.
const candidates = page.locator('[class*="sessionRow"]')
  .filter({ hasText: /\d+\s*(秒|分钟|小时|天|周|月|年)/ })
const candidateCount = await candidates.count()
let viewTab = page.locator('[role="tab"]:has-text("Jira")').last()
let viewTabFound = false
for (let i = 0; i < candidateCount; i++) {
  await candidates.nth(i).click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1500)
  viewTabFound = await viewTab.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
  if (viewTabFound) break
}

// The Jira view tab, then its Worklog sub-tab. Both mount asynchronously —
// the view ring appears once the session's views resolve — so the probe waits
// for the tab instead of clicking into the void.
await viewTab.click({ timeout: 8000 }).catch(() => {})
await page.waitForTimeout(2000)

const worklogTab = page.locator('button:has-text("Worklog")').last()
const worklogTabFound = await worklogTab.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)
await worklogTab.click({ timeout: 8000 }).catch(() => {})
await page.waitForTimeout(2000)

/**
 * The issue links, per table.
 *
 * The two tables are told apart by their caption row: the open-issues table
 * starts with "Key", the week table with the date column. The week table is
 * the one the bug was reported in.
 */
const readLinks = () => page.evaluate(() => {
  const read = (table) => Array.from(table.querySelectorAll('a')).map(a => {
    const text = (a.textContent ?? '').trim()
    return {
      text,
      href: a.getAttribute('href') ?? '',
      resolved: a.href,
      target: a.getAttribute('target') ?? '',
      rel: a.getAttribute('rel') ?? '',
    }
  }).filter(a => /^[A-Z][A-Z0-9_]*-\d+$/.test(a.text))
  const out = { week: [], open: [] }
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const head = (table.querySelector('thead')?.textContent ?? '').trim()
    if (head.startsWith('日期')) out.week.push(...read(table))
    else if (head.startsWith('Key')) out.open.push(...read(table))
  }
  return out
})

// The week table arrives from Jira, which is a network round trip per issue:
// poll until the rows are there rather than guessing how long it takes.
let links = await readLinks()
const deadline = Date.now() + 30000
while (links.week.length === 0 && Date.now() < deadline) {
  await page.waitForTimeout(1000)
  links = await readLinks()
}
await page.screenshot({ path: `${OUT_DIR}/01-worklog.png`, fullPage: true })

const server = (await (await page.request.get(`${BASE}/api/scjira/status`)).json())?.server ?? ''
const base = server.replace(/\/+$/, '')

/** Whether every link points at its own issue on the configured server. */
function pointsToItsIssue(list) {
  if (list.length === 0) return false
  return list.every(a => a.resolved === `${base}/browse/${a.text}` && a.target === '_blank')
}

const fragmentLinks = [...links.week, ...links.open].filter(a => a.href.startsWith('#'))
const weekLinksOk = pointsToItsIssue(links.week)

// The link has to be clickable, not merely present: click one and watch for
// the tab it opens. Jira answers with its login page when the browser is not
// signed in — the issue is still named in the destination, which is what the
// click was supposed to carry.
let clicked = null
if (links.week.length > 0) {
  const key = links.week[0].text
  const link = page.locator(`a:text-is("${key}")`).last()
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 15000 }).catch(() => null),
    link.click({ timeout: 8000 }).catch(() => {}),
  ])
  clicked = { key, url: popup?.url() ?? null }
  if (popup !== null) await popup.close().catch(() => {})
}
const clickOpensTheIssue = clicked !== null
  && clicked.url !== null
  && clicked.url.startsWith(`${base}/`)
  && clicked.url.includes(clicked.key)

const report = {
  base: BASE,
  server,
  viewTabFound,
  worklogTabFound,
  weekLinks: links.week,
  openLinks: links.open,
  weekLinksOk,
  fragmentLinkCount: fragmentLinks.length,
  clicked,
  clickOpensTheIssue,
  consoleErrors,
}
await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

await browser.close()

const pass = weekLinksOk && fragmentLinks.length === 0
  && clickOpensTheIssue && consoleErrors.length === 0
process.exit(pass ? 0 : 2)
