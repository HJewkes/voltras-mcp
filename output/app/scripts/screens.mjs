// Renders the nine required screens (plus optional extras) from a running preview server.
// Usage: node scripts/screens.mjs [baseUrl] [outDir]
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const base = process.argv[2] ?? 'http://localhost:4173/'
const out = process.argv[3] ?? '../screens'
const localChromium = `${homedir()}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`

const shots = []
for (const f of ['1', '2', '3']) {
  shots.push({ name: `${f}-wall-viewport`, q: `f=${f}`, w: 1440, h: 900, full: false })
  shots.push({ name: `${f}-wall-full`, q: `f=${f}`, w: 1440, h: 900, full: true })
  shots.push({ name: `${f}-phone-full`, q: `f=${f}`, w: 390, h: 844, full: true })
}
shots.push({ name: 'extra-2-wall-kg', q: 'f=2&unit=kg', w: 1440, h: 900, full: false })
shots.push({ name: 'extra-2-wall-light', q: 'f=2&theme=light', w: 1440, h: 900, full: false })

const browser = await chromium.launch(existsSync(localChromium) ? { executablePath: localChromium } : {})
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1, timezoneId: 'UTC' })
  await page.goto(`${base}?${s.q}`)
  await page.evaluate(() => document.fonts.ready)
  if (s.full) {
    // Grow the viewport to the page height so sticky chrome lands where it would at rest.
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    await page.setViewportSize({ width: s.w, height })
  }
  await page.screenshot({ path: `${out}/${s.name}.png` })
  await page.close()
}
await browser.close()
