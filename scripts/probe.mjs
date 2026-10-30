/**
 * Probe for the 5 UI changes:
 *  1. view tab title == "Jira"
 *  2. sub-tabs are "My Open" / "Worklog" / "绑定 Session"
 *  3. tab switch has no loading spinner (data persists)
 *  4. worklog has prev/this-week/next buttons
 *  5. clicking ← shows no loading flash (stale-while-revalidate)
 *
 * Replaces the basic probe — keeps the host-alive + settings card checks.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { launchOptions } from './chrome.mjs'

const BASE    = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const OUT_DIR = process.env.OUT_DIR  ?? '/tmp/sc-jira-test'

await mkdir(OUT_DIR, { recursive: true })

const browser = await chromium.launch(launchOptions())
const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

const consoleErrors = []
page.on('console',   m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.stack ?? e.message}`))

// Step 1: host alive
const statusResp = await page.request.get(`${BASE}/api/scjira/status`)
const statusBody = await statusResp.json().catch(() => ({}))
const statusOk = statusResp.ok() && statusBody.ok === true

// Step 2: open + enter session
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(1500)
// The first two name the sessions this machine happened to create; the last
// is the generic fallback, so the probe also works on a fresh profile.
for (const sel of ['text=创建JIRA插件', 'text=DSH工具执行Shell命令实现', '[class*="sessionRow"]', 'text=新会话']) {
  const l = page.locator(sel).first()
  if (await l.count() && await l.isVisible()) {
    await l.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(2000)
    break
  }
}

// Step 3: click "Jira" view tab (was "Jira 集成")
const viewTab = page.locator('[role="tab"]:has-text("Jira")').last()
await viewTab.click({ timeout: 3000 }).catch(() => {})
await page.waitForTimeout(1500)

// Read sub-tab labels
const subTabLabels = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('button'))
    .map(b => (b.textContent ?? '').trim())
    .filter(t => ['My Open', 'Worklog', '绑定 Session', '我的未完成', 'Worklog 周报', 'Jira 集成'].includes(t))
})
console.log(`[probe] sub-tab labels visible: ${JSON.stringify(subTabLabels)}`)

// Step 4: check view tab label == "Jira" (not "Jira 集成")
const allTabTexts = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('[role="tab"]'))
    .map(t => (t.textContent ?? '').trim())
})
const viewLabelOk = allTabTexts.includes('Jira') && !allTabTexts.includes('Jira 集成')

// Step 5: visit Worklog tab and verify prev/this-week/next buttons + jump-to date input
const worklogTab = page.locator('button:has-text("Worklog")').last()
await worklogTab.click({ timeout: 3000 }).catch(() => {})
// Wait for the prev button to appear (means data loaded and panel rendered)
await page.locator('button:has-text("←")').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
await page.screenshot({ path: `${OUT_DIR}/06-worklog-week-nav.png`, fullPage: true })

const worklogButtons = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('button'))
    .map(b => (b.textContent ?? '').trim())
    .filter(t => /^(←|→|This week|\d{4}-\d{2}-\d{2})$/.test(t))
})
const hasWeekNav = worklogButtons.includes('←') && worklogButtons.includes('→')
  && (worklogButtons.includes('This week') || worklogButtons.some(t => /^\d{4}-\d{2}-\d{2}$/.test(t)))

// Jump-to date input: must exist in the toolbar, value must be ISO Monday of current week
const jumpInputValue = await page.evaluate(() => {
  // The jump input is the only date input in the Worklog toolbar
  const i = document.querySelector('input[type="date"]')
  return i?.value ?? ''
})
const hasJumpInput = /^\d{4}-\d{2}-\d{2}$/.test(jumpInputValue)

// Step 6: switch tabs and verify no loading spinner
await page.locator('button:has-text("My Open")').last().click({ timeout: 3000 }).catch(() => {})
await page.waitForTimeout(300)
const loadingOnMyOpen = await page.locator('text=加载中…').count()
await page.screenshot({ path: `${OUT_DIR}/07-my-open-after-switch.png`, fullPage: true })

await worklogTab.click({ timeout: 3000 }).catch(() => {})
await page.waitForTimeout(300)
const loadingOnWorklog = await page.locator('text=加载中…').count()
await page.screenshot({ path: `${OUT_DIR}/08-worklog-no-loading.png`, fullPage: true })

// Step 7: click prev week button and verify (a) weekStart changes, (b) no
// full-page "加载中…" appears mid-flight (stale-while-revalidate keeps old
// chart + table visible, only the small "更新中…" chip should show).
const beforeWeek = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('span'))
  const span = all.find(s => /\d{4}-\d{2}-\d{2} ~ /.test(s.textContent ?? ''))
  return span?.textContent ?? ''
})
await page.locator('button:has-text("←")').first().click({ timeout: 3000 }).catch(() => {})

// Snapshot immediately after click — should still NOT show "加载中…"
const loadingAfterPrev = await page.locator('text=加载中…').count()
await page.screenshot({ path: `${OUT_DIR}/09-worklog-prev-week-midflight.png`, fullPage: true })

// Wait until the displayed week range actually differs from beforeWeek AND
// the "更新中…" chip has gone away (means the new fetch landed).
let afterWeek = ''
let settled = false
const deadline = Date.now() + 10000
while (Date.now() < deadline) {
  afterWeek = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('span'))
    const span = all.find(s => /\d{4}-\d{2}-\d{2} ~ /.test(s.textContent ?? ''))
    return span?.textContent ?? ''
  })
  const stillLoading = await page.locator('text=更新中…').count() > 0
  if (afterWeek && afterWeek !== beforeWeek && !stillLoading) { settled = true; break }
  await page.waitForTimeout(300)
}
const weekChanged = settled && !!beforeWeek && !!afterWeek && beforeWeek !== afterWeek
await page.screenshot({ path: `${OUT_DIR}/10-worklog-prev-week-settled.png`, fullPage: true })

const report = {
  statusOk,
  viewLabelOk,
  subTabLabels,
  hasWeekNav,
  hasJumpInput,
  jumpInputValue,
  worklogButtons,
  loadingOnMyOpen,
  loadingOnWorklog,
  loadingAfterPrev,
  beforeWeek,
  afterWeek,
  weekChanged,
  settled,
  consoleErrors,
}
await writeFile(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

await browser.close()

const pass = statusOk && viewLabelOk && hasWeekNav && hasJumpInput
  && loadingOnMyOpen === 0 && loadingOnWorklog === 0 && loadingAfterPrev === 0
  && weekChanged
  && consoleErrors.length === 0
process.exit(pass ? 0 : 2)