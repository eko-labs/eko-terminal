// Study a brand's website before designing: timed frames of the hero's intro motion, the full page
// in viewport slices, and its text → study/. Usage: node tools/study-site.mjs https://example.com
// Tile the frames for review with: node tools/tile.mjs study/sheet.png 3 640 study/hero-*.png
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
fs.mkdirSync(new URL('../study/', import.meta.url), { recursive: true });
const url = process.argv[2];
if (!url) { console.error('usage: node tools/study-site.mjs <url>'); process.exit(1); }
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('../study/', import.meta.url));
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'] });
const pg = await b.newPage();
await pg.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
const t0 = Date.now();
for (const t of [0.4, 0.8, 1.2, 1.6, 2.2, 3, 4.5, 6.5, 9]) {
  while ((Date.now() - t0) / 1000 < t) await new Promise((r) => setTimeout(r, 30));
  await pg.screenshot({ path: `${out}hero-${String(t).padStart(4, '0')}.png` });
}
const H = await pg.evaluate(() => document.documentElement.scrollHeight);
console.log('page height', H);
let i = 0;
for (let y = 0; y < H; y += 900) {
  await pg.evaluate((y) => window.scrollTo(0, y), y);
  await new Promise((r) => setTimeout(r, 1400));
  await pg.screenshot({ path: `${out}page-${String(i++).padStart(2, '0')}.png` });
}
fs.writeFileSync(`${out}text.txt`, await pg.evaluate(() => document.body.innerText));
await b.close();
