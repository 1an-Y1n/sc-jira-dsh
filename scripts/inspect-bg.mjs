/**
 * Get values of the most useful theme-aware aliases.
 */
import { chromium } from 'playwright'
import { launchOptions } from './chrome.mjs'

const BASE = 'http://127.0.0.1:3080'

const browser = await chromium.launch(launchOptions())
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(1500)

const WANTS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-brand-primary',
  '--dsw-alias-brand-text',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-ghost-active-fill',
]
const out = await page.evaluate((keys) => {
  const root = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  const r = {}
  for (const k of keys) {
    r[k] = {
      root: root.getPropertyValue(k).trim() || null,
      body: body.getPropertyValue(k).trim() || null,
    }
  }
  return r
}, WANTS)
console.log(JSON.stringify(out, null, 2))
await browser.close()