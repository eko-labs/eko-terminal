// Builds the SignalOS logo system as outlined SVGs (no font dependency).
// Run: node brand/scripts/build-logos.mjs
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'logo');

export const C = {
  ink: '#0A1624',
  white: '#FFFFFF',
  sky: '#4EB7FA',
  skyHi: '#7CCBFD',
  navy: '#05090D',
  navy2: '#0C1A2B',
  blue: '#2F95FF',
};

// Anton (SIL OFL), set heavy, condensed and slanted 12° — the "SIGNALOS" wordmark.
const fontFile = join(root, '..', 'apps/web/node_modules/@fontsource/anton/files/anton-latin-400-normal.woff');
const buf = readFileSync(fontFile);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const SLANT = Math.tan((12 * Math.PI) / 180);

/** Outlined, slanted "SIGNALOS". Returns path data with the baseline at y and its advance width. */
function wordmarkPath(size, x = 0, y = 0) {
  const tracking = size * 0.005;
  let cursor = x;
  const parts = [];
  const glyphs = [...'SIGNALOS'].map((ch) => font.charToGlyph(ch));
  glyphs.forEach((g, i) => {
    const p = g.getPath(cursor, y, size);
    // Slant around the baseline: x' = x + (y - baseline) * -tan(12°).
    for (const c of p.commands) {
      for (const [kx, ky] of [['x', 'y'], ['x1', 'y1'], ['x2', 'y2']]) if (c[kx] !== undefined) c[kx] = c[kx] - (c[ky] - y) * SLANT;
    }
    parts.push(p.toPathData(2));
    const kern = i < glyphs.length - 1 ? font.getKerningValue(g, glyphs[i + 1]) : 0;
    cursor += ((g.advanceWidth + kern) / font.unitsPerEm) * size + tracking;
  });
  const capH = (font.tables.os2.sCapHeight / font.unitsPerEm) * size;
  return { d: parts.join(''), width: cursor - x - tracking + capH * SLANT, capH };
}

// The mark: a glossy blue infinity ribbon — signals that never stop, looped through your decision.
const LOOP = 'M20 31C26 31 29 26 32 20C35 14 38 8.5 45 8.5C52 8.5 57 13.5 57 20C57 26.5 52 31.5 45 31.5C38 31.5 35 26 32 20C29 14 26 9 20 9C13.5 9 8.5 14 8.5 20C8.5 26 13.5 31 20 31Z';
const OVER = 'M20 31C26 31 29 26 32 20C35 14 38 8.5 45 8.5';

/** Glossy mark in a 64×40 box, placed at (x, y) scaled to width w. `id` keeps gradient ids unique per file. */
function mark({ x = 0, y = 0, w = 64, id = 'm' }) {
  const k = w / 64;
  return `<defs>
  <linearGradient id="${id}-body" x1="0" y1="5" x2="0" y2="35" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9ADDFF"/><stop offset=".33" stop-color="#3A9BFF"/><stop offset=".72" stop-color="#1459E6"/><stop offset="1" stop-color="#0A2E91"/></linearGradient>
  <linearGradient id="${id}-hl" x1="0" y1="5" x2="0" y2="35" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".5" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <mask id="${id}-tube"><path d="${LOOP}" stroke="#fff" stroke-width="8" fill="none"/></mask>
  <mask id="${id}-cross"><circle cx="32" cy="20" r="7.5" fill="#fff"/></mask>
  <filter id="${id}-blur" x="-20%" y="-30%" width="140%" height="170%"><feGaussianBlur stdDeviation="1.1"/></filter>
</defs>
<g transform="translate(${x} ${y}) scale(${k}) rotate(-8 32 20)">
  <path d="${LOOP}" stroke="#03143F" stroke-opacity=".42" stroke-width="8" fill="none" transform="translate(.6 2.1)" filter="url(#${id}-blur)"/>
  <path d="${LOOP}" stroke="#0A2C85" stroke-width="8" fill="none" transform="translate(0 .9)"/>
  <path d="${LOOP}" stroke="url(#${id}-body)" stroke-width="8" fill="none"/>
  <g mask="url(#${id}-tube)"><path d="${LOOP}" stroke="url(#${id}-hl)" stroke-width="2.4" fill="none" transform="translate(0 -2.2)"/></g>
  <g mask="url(#${id}-cross)"><path d="${OVER}" stroke="#03143F" stroke-opacity=".55" stroke-width="10" fill="none" filter="url(#${id}-blur)" transform="translate(0 .6)"/></g>
  <path d="${OVER}" stroke="#0A2C85" stroke-width="8" fill="none" transform="translate(0 .9)"/>
  <path d="${OVER}" stroke="url(#${id}-body)" stroke-width="8" fill="none"/>
  <g mask="url(#${id}-tube)"><path d="${OVER}" stroke="url(#${id}-hl)" stroke-width="2.4" fill="none" transform="translate(0 -2.2)"/></g>
  <ellipse cx="45" cy="10.4" rx="4.2" ry="1.1" fill="#fff" opacity=".8"/>
  <ellipse cx="17.5" cy="10.9" rx="2.6" ry=".85" fill="#fff" opacity=".6"/>
</g>`;
}

/** Flat single-colour mark (for mono lockups, stamps and tiny sizes). */
function flatMark({ x = 0, y = 0, w = 64, color }) {
  const k = w / 64;
  return `<g transform="translate(${x} ${y}) scale(${k}) rotate(-8 32 20)"><path d="${LOOP}" stroke="${color}" stroke-width="8" fill="none"/></g>`;
}

function svg(w, h, body, bg = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}">${bg}
${body}
</svg>
`;
}

const skyBg = (w, h, r = 0) =>
  `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.sky}"/><stop offset="1" stop-color="${C.skyHi}"/></linearGradient></defs><rect width="${w}" height="${h}" rx="${r}" fill="url(#bg)"/>`;
const navyBg = (w, h, r = 0) =>
  `<defs><radialGradient id="bg" cx=".3" cy=".2" r="1"><stop offset="0" stop-color="${C.navy2}"/><stop offset="1" stop-color="${C.navy}"/></radialGradient></defs><rect width="${w}" height="${h}" rx="${r}" fill="url(#bg)"/>`;

const files = {};
const SIZE = 100;

// Symbol
files['symbol.svg'] = svg(64, 40, mark({}));
files['symbol-mono-ink.svg'] = svg(64, 40, flatMark({ color: C.ink }));
files['symbol-mono-white.svg'] = svg(64, 40, flatMark({ color: C.white }));

// Wordmark, horizontal lockup (wordmark + mark), stacked lockup
function wordmarkSvg(color) {
  const wm = wordmarkPath(SIZE, 0, SIZE);
  return svg(wm.width, SIZE * 1.02, `<path d="${wm.d}" fill="${color}"/>`);
}
function lockup({ color, glossy = true, bg = null, pad = 0 }) {
  const wm = wordmarkPath(SIZE, pad, pad + SIZE * 0.92);
  const markW = wm.capH * 1.95;
  const markH = (markW * 40) / 64;
  const gap = -SIZE * 0.025;
  const mx = pad + wm.width + gap;
  const my = pad + SIZE * 0.92 - wm.capH / 2 - markH / 2;
  const w = mx + markW + pad;
  const h = SIZE * 0.98 + pad * 2;
  const m = glossy ? mark({ x: mx, y: my, w: markW, id: 'lk' }) : flatMark({ x: mx, y: my, w: markW, color });
  return svg(w, h, `<path d="${wm.d}" fill="${color}"/>${m}`, bg ? bg(w, h) : '');
}
function stacked({ color, glossy = true, bg = null, pad = 0 }) {
  const wm0 = wordmarkPath(SIZE, 0, 0);
  const markW = wm0.capH * 2.4;
  const markH = (markW * 40) / 64;
  const w = Math.max(wm0.width, markW) + pad * 2;
  const mx = (w - markW) / 2;
  const wm = wordmarkPath(SIZE, (w - wm0.width) / 2, pad + markH + SIZE * 0.9);
  const h = pad * 2 + markH + SIZE * 0.98;
  const m = glossy ? mark({ x: mx, y: pad, w: markW, id: 'st' }) : flatMark({ x: mx, y: pad, w: markW, color });
  return svg(w, h, `${m}<path d="${wm.d}" fill="${color}"/>`, bg ? bg(w, h) : '');
}

files['wordmark-ink.svg'] = wordmarkSvg(C.ink);
files['wordmark-white.svg'] = wordmarkSvg(C.white);
files['lockup-ink.svg'] = lockup({ color: C.ink });
files['lockup-white.svg'] = lockup({ color: C.white });
files['lockup-on-sky.svg'] = lockup({ color: C.ink, bg: skyBg, pad: 44 });
files['lockup-on-navy.svg'] = lockup({ color: C.white, bg: navyBg, pad: 44 });
files['lockup-mono-ink.svg'] = lockup({ color: C.ink, glossy: false });
files['lockup-mono-white.svg'] = lockup({ color: C.white, glossy: false });
files['stacked-ink.svg'] = stacked({ color: C.ink });
files['stacked-white.svg'] = stacked({ color: C.white });
files['stacked-on-sky.svg'] = stacked({ color: C.ink, bg: skyBg, pad: 56 });
files['stacked-on-navy.svg'] = stacked({ color: C.white, bg: navyBg, pad: 56 });

// App icons (squircle) + favicon: the glossy mark on navy or on sky.
const icon = (s, bg, id) => svg(s, s, mark({ x: s * 0.12, y: s * 0.5 - s * 0.76 * (40 / 64) / 2, w: s * 0.76, id }), bg(s, s, s * 0.23));
files['app-icon.svg'] = icon(1024, navyBg, 'ai');
files['app-icon-sky.svg'] = icon(1024, skyBg, 'as');
files['favicon.svg'] = icon(64, navyBg, 'fv');

const pub = join(root, '..', 'apps/web/public/brand/logo');
for (const dir of [out, pub]) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.svg') && !(f in files)) rmSync(join(dir, f));
}
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(out, name), content);
  writeFileSync(join(pub, name), content);
}
writeFileSync(join(root, '..', 'apps/web/public/favicon.svg'), files['favicon.svg']);
console.log(`wrote ${Object.keys(files).length} logo files to brand/logo/`);
