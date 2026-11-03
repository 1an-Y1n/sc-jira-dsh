/**
 * Probe for the SETTINGS page (the visual repair):
 *  1. the settings modal opens
 *  2. the nav rail lists the sections — and the Jira gear is GONE, because
 *     the configuration card moved into 插件 → 插件配置
 *  3. the Jira card is there, carries the Jira mark, and is built like its
 *     siblings: the same card geometry, the same field rhythm
 *
 * "Looks like the other pages" is measured here — card radius, fill, border
 * and field heights are read off the DOM and compared with the card next to
 * it — rather than asserted by eye.
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchOptions } from './chrome.mjs'

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/sc-jira-settings-probe'

await mkdir(OUT_DIR, { recursive: true })

const browser = await chromium.launch(launchOptions())
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await ctx.newPage()

const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.stack ?? e.message}`))

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2000)

const loadFailure = await page.evaluate(() => {
  const text = document.body.innerText ?? ''
  const m = /failed to apply loader entry[^\n]*/i.exec(text)
  return m?.[0] ?? (text.includes('Failed to load plugins') ? 'Failed to load plugins' : '')
})

// The settings trigger is the sidebar-foot button that opens the dialog.
const trigger = page.locator('button[aria-haspopup="dialog"]').first()
const triggerFound = await trigger.count() > 0
await trigger.click({ timeout: 8000 }).catch(() => {})
await page.waitForTimeout(1200)

const dialogFound = await page.locator('[role="dialog"]').count() > 0
await page.screenshot({ path: `${OUT_DIR}/01-modal.png` })

// The nav rail: one row per settings.section registrant, each with the glyph
// the shell draws for it.
const navRows = await page.evaluate(() => {
  const out = []
  for (const btn of Array.from(document.querySelectorAll('[role="dialog"] nav button'))) {
    const svg = btn.querySelector('svg')
    out.push({
      label: (btn.textContent ?? '').trim(),
      hasGlyph: svg !== null,
      glyphPaths: svg ? svg.querySelectorAll('path,circle,rect,line').length : 0,
    })
  }
  return out
})
const jiraInRail = navRows.some(row => row.label === 'Jira')

// Open the Plugins section, then its plugin-configuration tab.
const pluginsRow = page.locator('[role="dialog"] nav button').filter({ hasText: '插件' }).first()
await pluginsRow.click({ timeout: 5000 }).catch(() => {})
await page.waitForTimeout(1200)

const configTab = page.locator('[role="dialog"] [role="tab"]').filter({ hasText: '插件配置' }).first()
const configTabFound = await configTab.count() > 0
await configTab.click({ timeout: 5000 }).catch(() => {})
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT_DIR}/02-plugin-config.png` })

/**
 * The card list of the configurable tab, with the geometry the visual repair
 * is about: the card box, its header, and the mark beside the name.
 */
const cards = await page.evaluate(() => {
  const panel = document.querySelector('[role="dialog"] [role="tabpanel"]:not([hidden])')
  if (!panel) return []
  const out = []
  for (const card of Array.from(panel.querySelectorAll('li'))) {
    const box = getComputedStyle(card)
    const header = card.querySelector('button')
    const headerBox = header ? getComputedStyle(header) : null
    const mark = card.querySelector('svg')
    const name = card.querySelector('span')
    out.push({
      text: (card.textContent ?? '').trim().slice(0, 60),
      borderRadius: box.borderRadius,
      background: box.backgroundColor,
      border: box.border,
      headerPadding: headerBox?.padding ?? '',
      headerGap: headerBox?.gap ?? '',
      hasMark: mark !== null,
      markGradients: mark ? mark.querySelectorAll('linearGradient').length : 0,
      markPaths: mark ? mark.querySelectorAll('path').length : 0,
      name: name?.textContent ?? '',
    })
  }
  return out
})

const jiraCard = cards.find(card => card.name === 'Jira' || card.text.startsWith('Jira'))
const sibling = cards.find(card => card !== jiraCard)

// Open the Jira card and read its fields.
if (jiraCard) {
  const header = page.locator('[role="dialog"] [role="tabpanel"]:not([hidden]) li')
    .filter({ hasText: 'Jira' })
    .first()
    .locator('button')
    .first()
  await header.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1500)
}
await page.screenshot({ path: `${OUT_DIR}/03-jira-card.png` })

const fields = await page.evaluate(() => {
  const panel = document.querySelector('[role="dialog"] [role="tabpanel"]:not([hidden])')
  if (!panel) return null
  const jira = Array.from(panel.querySelectorAll('li')).find(li => (li.textContent ?? '').trim().startsWith('Jira'))
  if (!jira) return null
  const inputs = Array.from(jira.querySelectorAll('input, select'))
  const buttons = Array.from(jira.querySelectorAll('button'))
  return {
    labels: Array.from(jira.querySelectorAll('label')).map(l => (l.textContent ?? '').trim()),
    inputHeights: inputs.map(el => getComputedStyle(el).height),
    inputRadii: inputs.map(el => getComputedStyle(el).borderRadius),
    buttons: buttons.map(el => {
      const s = getComputedStyle(el)
      return { text: (el.textContent ?? '').trim(), height: s.height, radius: s.borderRadius }
    }),
    // Only a NON-EMPTY style attribute counts: Playwright's screenshot hides
    // the caret by touching `style.caretColor` on the focused inputs, and it
    // leaves the empty attribute behind. The card's own rules live in its
    // stylesheet.
    inlineStyles: Array.from(jira.querySelectorAll('[style]'))
      .filter(el => (el.getAttribute('style') ?? '').trim() !== '').length,
    styledTags: Array.from(jira.querySelectorAll('[style]'))
      .map(el => `${el.tagName}:${el.getAttribute('style') ?? ''}`),
    cssVars: (jira.innerHTML.match(/var\(/g) ?? []).length,
  }
})

/**
 * The write path, exercised end to end.
 *
 * It flips one harmless setting (the scope mode), saves, checks that the Host
 * holds the new value, and puts the old one back — so the probe proves the
 * round trip without leaving the deployment changed. Off by default: it writes.
 */
let saveRoundTrip = null
if (process.env.PROBE_SAVE === '1') {
  const readStatus = async () => {
    const response = await page.request.get(`${BASE}/api/scjira/status`)
    return await response.json()
  }
  const before = await readStatus()
  const target = before.scopeMode === 'narrow' ? 'advisory' : 'narrow'
  const select = page.locator('#scjira-scope-mode')
  await select.selectOption(target)
  const saveButton = page.locator('li.scjira-card button.scjira-save')
  const saveEnabled = await saveButton.isEnabled()
  await saveButton.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const after = await readStatus()
  // Put the deployment back the way it was.
  await select.selectOption(before.scopeMode)
  await saveButton.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const restored = await readStatus()
  saveRoundTrip = {
    saveEnabled,
    wrote: after.scopeMode === target,
    restored: restored.scopeMode === before.scopeMode,
    status: await page.locator('li.scjira-card .scjira-status').first().innerText().catch(() => ''),
  }
}

const report = {
  base: BASE,
  loadFailure,
  triggerFound,
  dialogFound,
  navRows,
  jiraInRail,
  configTabFound,
  cards,
  jiraCard: jiraCard ?? null,
  siblingCard: sibling ?? null,
  fields,
  saveRoundTrip,
  consoleErrors,
}
await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

await browser.close()
