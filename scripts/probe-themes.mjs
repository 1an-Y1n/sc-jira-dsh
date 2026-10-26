/**
 * Theme-aware probe — captures the sc-jira view in both light and dark
 * color schemes to verify CSS variable resolution works for both.
 */
import { chromium } from 'playwright'
import { writeFile, mkdir } from 'node:fs/promises'
import { launchOptions } from './chrome.mjs'

const BASE    = 'http://127.0.0.1:3080'
const OUT_DIR = '/tmp/sc-jira-test'

await mkdir(OUT_DIR, { recursive: true })

const browser = await chromium.launch(launchOptions())

async function runWith(scheme, label) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: scheme,
  })
  const page = await ctx.newPage()
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.stack ?? e.message}`))

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1500)

  for (const sel of ['text=创建JIRA插件', 'text=DSH工具执行Shell命令实现', '[class*="sessionRow"]']) {
    const l = page.locator(sel).first()
    if (await l.count() && await l.isVisible()) {
      await l.click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(2000)
      break
    }
  }

  const tab = page.locator('button:has-text("Jira 集成")').last()
  if (await tab.count()) {
    await tab.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(2000)
  }

  const shot = `${OUT_DIR}/theme-${label}.png`
  await page.screenshot({ path: shot, fullPage: true })

  // Probe the actual computed bg of our panel for verification
  const bg = await page.evaluate(() => {
    const root = document.body
    const cs = getComputedStyle(root)
    return {
      bodyBg: cs.backgroundColor,
      bodyColor: cs.color,
      bgBaseVar: cs.getPropertyValue('--dsw-alias-bg-base').trim(),
      fgPrimaryVar: cs.getPropertyValue('--dsw-alias-label-primary').trim(),
    }
  })
  console.log(`[${label}] ${JSON.stringify(bg)} shot=${shot} errors=${consoleErrors.length}`)
  await ctx.close()
}

await runWith('light', 'light')
await runWith('dark',  'dark')
await browser.close()