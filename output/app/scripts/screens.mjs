// Renders every fixture at wall and phone size. Usage: npm run build && npm run screens
import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../../screens/', import.meta.url));
const FIXTURES = ['current', 'full', 'edges'];
const SIZES = [
  { name: 'wall', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');

mkdirSync(outDir, { recursive: true });
const server = await preview({ preview: { port: 4179, strictPort: true } });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

for (const theme of THEMES) {
  for (const size of SIZES) {
    const page = await browser.newPage({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.name === 'phone' ? 2 : 1,
    });
    for (const fixture of FIXTURES) {
      await page.goto(`http://localhost:4179/?fixture=${fixture}&theme=${theme}&shot`);
      await page.evaluate(() => document.fonts.ready);
      const base = `${outDir}${fixture}-${size.name}-${theme}`;
      await page.screenshot({ path: `${base}.png` });
      // A pinned tab bar would be stamped mid-page in a stitched capture.
      await page.addStyleTag({ content: '.nav { position: static !important; }' });
      await page.screenshot({ path: `${base}-full.png`, fullPage: true });
    }
    await page.close();
  }
}

const kg = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await kg.goto('http://localhost:4179/?fixture=full&units=kg&shot');
await kg.evaluate(() => document.fonts.ready);
await kg.screenshot({ path: `${outDir}full-wall-dark-kg.png` });

await browser.close();
server.httpServer.close();
