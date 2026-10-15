// Captures the nine required screens (plus kg and light extras) from a running dev server.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.BASE_URL ?? "http://localhost:5199";
const out = new URL("../../screens/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const fixtures = { 1: "current", 2: "full-session", 3: "edges" };
const shots = [];
for (const [f, name] of Object.entries(fixtures)) {
  shots.push({ file: `${f}-${name}-wall.png`, q: `f=${f}`, w: 1440, h: 900, full: false });
  shots.push({ file: `${f}-${name}-wall-full.png`, q: `f=${f}`, w: 1440, h: 900, full: true });
  shots.push({ file: `${f}-${name}-phone.png`, q: `f=${f}`, w: 390, h: 844, full: true, mobile: true });
}
shots.push({ file: "extra-2-full-session-wall-kg.png", q: "f=2&units=kg", w: 1440, h: 900, full: false });
shots.push({ file: "extra-1-current-phone-kg.png", q: "f=1&units=kg", w: 390, h: 844, full: true, mobile: true });
shots.push({ file: "extra-2-full-session-wall-light.png", q: "f=2&theme=light", w: 1440, h: 900, full: false });

const browser = await chromium.launch();
for (const s of shots) {
  const context = await browser.newContext({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: s.mobile ? 2 : 1,
    isMobile: Boolean(s.mobile),
    timezoneId: "UTC",
    locale: "en-GB",
  });
  const page = await context.newPage();
  await page.goto(`${base}/?${s.q}`, { waitUntil: "networkidle" });
  if (s.full) {
    // Grow the viewport to the document so sticky chrome sits at the true bottom.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: s.w, height: Math.max(height, s.h) });
  }
  await page.screenshot({ path: out + s.file, fullPage: s.full });
  await context.close();
  console.log("wrote", s.file);
}
await browser.close();
