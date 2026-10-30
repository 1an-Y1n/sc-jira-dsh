/**
 * Probe for the command surface (P6/P7):
 *  1. the host commands reach the client's command catalog —
 *     `/jira-bind`, `/jira-unbind`, `/jira-worklog` must be listed
 *  2. the bare `/jira-bind` opens the issue picker
 *  3. the picker lists the open issues, fetched from the host
 *
 * The picker is a DECORATION of a host command: the decoration never
 * manufactures a row of its own. So a visible `/jira-bind` row proves the
 * host registered the command AND the client decorated it — one check, both
 * halves.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { launchOptions } from './chrome.mjs'

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3092'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/sc-jira-cmd-test'

await mkdir(OUT_DIR, { recursive: true })

const browser = await chromium.launch(launchOptions())
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()

const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.stack ?? e.message}`))

// Step 1: the host is alive and the plugin is loaded.
const statusResp = await page.request.get(`${BASE}/api/scjira/status`)
const statusBody = await statusResp.json().catch(() => ({}))
const statusOk = statusResp.ok() && statusBody.ok === true

// Step 2: open the app and land on a session — the command catalog is
// per-agent, so there must be an agent to list commands for.
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(1500)

// A plugin whose client half fails to apply takes the WHOLE page down with
// it — the harness shows "Failed to load plugins" instead of the app. That
// failure is loud here rather than as a missing command row much later.
const loadFailure = await page.evaluate(() => {
  const text = document.body.innerText ?? ''
  const m = /failed to apply loader entry[^\n]*/i.exec(text)
  return m?.[0] ?? (text.includes('Failed to load plugins') ? 'Failed to load plugins' : '')
})

for (const sel of ['text=创建JIRA插件', 'text=DSH工具执行Shell命令实现', '[class*="sessionRow"]']) {
  const l = page.locator(sel).first()
  if (await l.count() && await l.isVisible()) {
    await l.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(2500)
    break
  }
}
await page.screenshot({ path: `${OUT_DIR}/01-session.png`, fullPage: true })

// Step 3: focus the composer and type the trigger. The menu that opens lists
// the command catalog for this session.
const composer = page.locator('textarea, [contenteditable="true"]').first()
const composerFound = await composer.count() > 0
await composer.click({ timeout: 5000 }).catch(() => {})
await page.waitForTimeout(500)
await page.keyboard.type('/jira', { delay: 120 })
await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT_DIR}/02-command-menu.png`, fullPage: true })

// The menu rows are buttons or list items whose text names the command.
const menuRows = await page.evaluate(() => {
  const wanted = ['jira-bind', 'jira-unbind', 'jira-worklog']
  const found = []
  for (const el of Array.from(document.querySelectorAll('button, [role="option"], [role="menuitem"], li'))) {
    const text = (el.textContent ?? '').trim()
    for (const w of wanted) {
      if (text.includes(w) && !found.includes(w)) found.push(w)
    }
  }
  return found
})
const bindListed = menuRows.includes('jira-bind')
const unbindListed = menuRows.includes('jira-unbind')
const worklogListed = menuRows.includes('jira-worklog')

// Step 4: pick the bare `/jira-bind` row. A decorated bare invocation opens
// the picker instead of running the command with no argument.
await page.keyboard.press('Backspace')
for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace')
await page.waitForTimeout(800)
await page.keyboard.type('/jira-bind', { delay: 120 })
await page.waitForTimeout(2500)
await page.screenshot({ path: `${OUT_DIR}/03-menu-bind.png`, fullPage: true })

const bindRow = page.locator('button, [role="option"], [role="menuitem"], li').filter({ hasText: 'jira-bind' }).first()
await bindRow.click({ timeout: 5000 }).catch(() => {})
await page.waitForTimeout(3500)
await page.screenshot({ path: `${OUT_DIR}/04-picker.png`, fullPage: true })

// The picker lists the open issues as options — each carrying an issue key.
const pickerOptions = await page.evaluate(() => {
  const found = []
  for (const el of Array.from(document.querySelectorAll('button, [role="option"], li'))) {
    const text = (el.textContent ?? '').trim()
    const m = /\b[A-Z][A-Z0-9_]*-\d+\b/.exec(text)
    if (m) found.push(text.slice(0, 120))
  }
  return Array.from(new Set(found)).slice(0, 12)
})
const pickerOpen = pickerOptions.length > 0

const report = {
  statusOk,
  loadFailure,
  composerFound,
  menuRows,
  bindListed,
  unbindListed,
  worklogListed,
  pickerOpen,
  pickerOptions,
  consoleErrors,
}
await writeFile(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

await browser.close()

const pass = statusOk && loadFailure === '' && composerFound && bindListed && unbindListed
  && worklogListed && pickerOpen && consoleErrors.length === 0
process.exit(pass ? 0 : 2)
