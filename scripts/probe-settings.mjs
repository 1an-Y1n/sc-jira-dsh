/**
 * Probe for the BUNDLE CONFIGURATION page (DSH 0.2.x layout).
 *
 * 0.1.x put the card in the settings modal — 插件 → 插件配置 — where it sat
 * beside the harness's own plugin cards, in a list of `li` elements.
 *
 * 0.2.x gives every plugin that lives OUTSIDE the harness repository a page
 * of its own under 插件 → 已安装插件, and reserves the keyed slot
 * `plugins.bundle.config` on that page for the bundle's configuration. The
 * card therefore renders as the page's SOLE config component — a `div`, not a
 * list item — inside the `[data-plugin-config]` section.
 *
 * This probe walks that path and measures what it finds:
 *  1. the plugin manager lists the bundle
 *  2. the bundle's page carries the `plugins.bundle.config` seat
 *  3. the card is there, carries the Jira mark, and its fields are the ones
 *     the Host answered with — the token among them, masked
 *
 * "Looks like the other pages" is measured here — card radius, fill, border
 * and field heights are read off the DOM — rather than asserted by eye.
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchOptions } from './chrome.mjs'

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3093/'
// The page URL carries the access token as a query parameter; the API does
// not take it, so the two addresses are kept apart.
const API = BASE.replace(/\?.*$/, '').replace(/\/+$/, '')
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

// The 0.2 preview notice opens as a modal over everything; dismiss it first.
for (const label of ['继续', '知道了', '我知道了', '确定']) {
  const btn = page.getByRole('button', { name: label, exact: true }).first()
  if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
    await btn.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(800)
  }
}

// Step 1: the plugin manager.
const pluginsButton = page.getByRole('button', { name: /插件|Plugins/ }).first()
const pluginsButtonFound = await pluginsButton.count() > 0
await pluginsButton.click({ timeout: 8000, force: true }).catch(() => {})
await page.waitForTimeout(1500)
await page.screenshot({ path: join(OUT_DIR, '01-plugins.png'), fullPage: true })

const bundleButtons = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('button'))
    .map(b => (b.textContent ?? '').trim().replace(/\s+/g, ' '))
    .filter(t => /@ian\/sc-jira/.test(t))
})
const bundleListed = bundleButtons.length > 0

// Step 2: the bundle's own page.
const bundleButton = page.getByRole('button', { name: /@ian\/sc-jira/ }).first()
const bundlePageOpened = await bundleButton.count() > 0
await bundleButton.click({ timeout: 8000, force: true }).catch(() => {})
await page.waitForTimeout(2000)
await page.screenshot({ path: join(OUT_DIR, '02-bundle-page.png'), fullPage: true })

/**
 * The `plugins.bundle.config` seat, with the geometry the card is built in:
 * the card box, its header, and the mark beside the name.
 */
const cards = await page.evaluate(() => {
  const seat = document.querySelector('[data-plugin-config]')
  if (!seat) return []
  const out = []
  for (const card of Array.from(seat.querySelectorAll('.scjira-card, li'))) {
    const box = getComputedStyle(card)
    const header = card.querySelector('button')
    const headerBox = header ? getComputedStyle(header) : null
    const mark = card.querySelector('svg')
    const name = card.querySelector('span')
    out.push({
      tag: card.tagName,
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

const seatFound = await page.locator('[data-plugin-config]').count() > 0
const card = page.locator('.scjira-card').first()
const cardFound = await card.count() > 0

// Open the disclosure and read the fields the Host answered with.
const header = page.locator('.scjira-header').first()
if (await header.count() > 0) {
  await header.click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(1500)
}
await page.screenshot({ path: join(OUT_DIR, '03-jira-card.png'), fullPage: true })

const fields = await page.evaluate(() => {
  const jira = document.querySelector('.scjira-card')
  if (!jira) return null
  const inputs = Array.from(jira.querySelectorAll('input, select'))
  const buttons = Array.from(jira.querySelectorAll('button'))
  return {
    labels: Array.from(jira.querySelectorAll('label')).map(l => (l.textContent ?? '').trim()),
    inputHeights: inputs.map(el => getComputedStyle(el).height),
    inputRadii: inputs.map(el => getComputedStyle(el).borderRadius),
    // The token must never be readable in the DOM: the Host redacts secrets
    // and the card shows a password field with an empty value.
    tokenFieldType: jira.querySelector('#scjira-token')?.getAttribute('type') ?? null,
    tokenFieldValue: jira.querySelector('#scjira-token')?.value ?? null,
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
    const response = await page.request.get(`${API}/api/scjira/status`)
    return await response.json()
  }
  const before = await readStatus()
  const target = before.scopeMode === 'narrow' ? 'advisory' : 'narrow'
  const select = page.locator('#scjira-scope-mode')
  await select.selectOption(target)
  const saveButton = page.locator('.scjira-card button.scjira-save')
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
    status: await page.locator('.scjira-card .scjira-status').first().innerText().catch(() => ''),
  }
}

const report = {
  base: BASE,
  loadFailure,
  pluginsButtonFound,
  bundleListed,
  bundleButtons,
  bundlePageOpened,
  seatFound,
  cardFound,
  cards,
  fields,
  saveRoundTrip,
  consoleErrors,
}
await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

await browser.close()
