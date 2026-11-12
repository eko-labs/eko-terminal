// Shared helpers for kit templates. Deterministic: renders the same pixels every time.
const K = {
  ink: '#0D0C12', paper: '#FFF4E0', violet: '#7B5CFF', go: '#2DE39E', stop: '#FF5A4F', beam: '#FFD23F', sky: '#3DB9FF', live: '#FF3E9D', tangerine: '#FF8B2C',
};

function pinSvg({ size = 64, color = K.violet, chevron = K.ink, ring, dir = 'up' } = {}) {
  const chev = dir === 'up' ? 'M23.5 36 L32 27.5 L40.5 36' : 'M23.5 28 L32 36.5 L40.5 28';
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28.5" fill="none" stroke="${ring || color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="132 47" transform="rotate(-38 32 32)"/><circle cx="32" cy="32" r="19.5" fill="${color}"/><path d="${chev}" fill="none" stroke="${chevron}" stroke-width="6.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Same glyph paths as apps/web/src/components/identity.tsx
const GLYPHS = {
  wave: '<path d="M2 10c1.6 0 1.6-4 3.2-4s1.6 4 3.2 4 1.6-4 3.2-4 1.6 4 2.4 4" />',
  bolt: '<path d="M9.4 2 4.5 9h3.6l-1 5L12 7H8.4l1-5Z" />',
  spring: '<path d="M3 12.5 5.2 3.5 7.4 12.5 9.6 3.5 11.8 12.5 13 7.5" />',
  gate: '<path d="M4 3v10M12 3v10" /><path d="M2 8h8.5M8.5 5.5 11 8l-2.5 2.5" />',
  hex: '<path d="M8 2.2 13 5v6l-5 2.8L3 11V5l5-2.8Z" /><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />',
  orbit: '<circle cx="8" cy="8" r="2.4" /><ellipse cx="8" cy="8" rx="6" ry="3.2" transform="rotate(-24 8 8)" /><circle cx="13.2" cy="5.6" r="1.1" fill="currentColor" stroke="none" />',
  prism: '<path d="M8 2.5 13.5 12.5h-11L8 2.5Z" /><path d="M8 2.5v10" />',
  compass: '<circle cx="8" cy="8" r="5.6" /><path d="m10.4 5.6-1.6 3.2-3.2 1.6 1.6-3.2 3.2-1.6Z" fill="currentColor" />',
  flare: '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M3.8 3.8l2 2M10.2 10.2l2 2M12.2 3.8l-2 2M5.8 10.2l-2 2" />',
  delta: '<path d="M8 3 13.5 13h-11L8 3Z" /><path d="M5.5 10h5" />',
  ring: '<circle cx="8" cy="8" r="5.6" /><circle cx="8" cy="8" r="2.8" /><circle cx="8" cy="2.4" r="1" fill="currentColor" stroke="none" />',
};

// Mirrors apps/server/src/bots/catalog.ts
const CREW = [
  ['Tideline', 'wave', 182], ['Kinetic', 'bolt', 40], ['Recoil', 'spring', 198], ['Breakline', 'gate', 262],
  ['Meridian', 'orbit', 24], ['Vector', 'prism', 306], ['Lumen', 'flare', 56], ['Halcyon', 'compass', 230],
  ['Deep Current', 'delta', 214], ['Quorum', 'hex', 326], ['Council', 'ring', 284],
];

function avatar(glyph, hue, size = 120, rot = 0) {
  return `<span class="av" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.3)}px;background:hsl(${hue} 92% 66%);transform:rotate(${rot}deg)"><svg width="${Math.round(size * 0.58)}" height="${Math.round(size * 0.58)}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[glyph]}</svg></span>`;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
}

/** A dark mini chart with candles, and a buy pin + pill on the last closed candle. */
function chartSvg({ w = 600, h = 340, n = 30, seed = 46630, pill = true } = {}) {
  const r = rng(seed);
  const c = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const d = i < n * 0.62 ? -1.1 : i < n * 0.82 ? -0.1 : 0.9;
    const o = p, cl = o + d + (r() - 0.5) * 4.6;
    c.push({ o, c: cl, h: Math.max(o, cl) + r() * 2.2, l: Math.min(o, cl) - r() * 2.2 });
    p = cl;
  }
  const hi = Math.max(...c.map((k) => k.h)), lo = Math.min(...c.map((k) => k.l));
  const y = (v) => 20 + ((hi - v) / (hi - lo)) * (h - 80);
  const step = (w - 80) / n;
  const x = (i) => 16 + i * step + step / 2;
  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  [0.25, 0.5, 0.75].forEach((f) => (s += `<line x1="0" x2="${w}" y1="${h * f}" y2="${h * f}" stroke="rgba(255,244,224,.07)" stroke-width="1.5"/>`));
  c.forEach((k, i) => {
    const col = k.c >= k.o ? K.go : K.stop;
    const top = y(Math.max(k.o, k.c)), bh = Math.max(3, Math.abs(y(k.o) - y(k.c)));
    s += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(k.h)}" y2="${y(k.l)}" stroke="${col}" stroke-width="2.4"/><rect x="${x(i) - step * 0.32}" y="${top}" width="${step * 0.64}" height="${bh}" rx="2" fill="${col}"/>`;
  });
  const si = n - 2, k = c[si], px = x(si), py = y(k.l) + 30;
  s += `<g transform="translate(${px - 22} ${py - 22})">${pinSvg({ size: 44, color: K.go })}</g>`;
  if (pill)
    s += `<g font-family="Bricolage" font-weight="800"><rect x="${px - 238}" y="${py - 20}" width="206" height="40" rx="20" fill="#15131c" stroke="${K.go}" stroke-width="2.5"/><path d="M${px - 218} ${py - 20} h70 v40 h-70 a20 20 0 0 1 -20 -20 a20 20 0 0 1 20 -20z" fill="${K.go}"/><text x="${px - 224}" y="${py + 7}" font-size="18" fill="${K.ink}">▲ BUY</text><text x="${px - 138}" y="${py + 7}" font-size="18" fill="#f7f1e6" font-weight="650">Tideline</text></g>`;
  return s + '</svg>';
}

document.querySelectorAll('[data-pin]').forEach((el) => {
  const o = JSON.parse(el.getAttribute('data-pin') || '{}');
  el.innerHTML = pinSvg(o);
});
document.querySelectorAll('[data-av]').forEach((el) => {
  const [g, hue, size, rot] = el.getAttribute('data-av').split(',');
  el.innerHTML = avatar(g, +hue, +(size || 120), +(rot || 0));
});
document.querySelectorAll('[data-chart]').forEach((el) => {
  el.innerHTML = chartSvg(JSON.parse(el.getAttribute('data-chart') || '{}'));
});
document.querySelectorAll('[data-crew]').forEach((el) => {
  const size = +(el.getAttribute('data-crew') || 120);
  el.innerHTML = CREW.map(([name, g, hue], i) => `<figure class="crew-item">${avatar(g, hue, size, ((i * 53) % 13) - 6)}<figcaption>${name}</figcaption></figure>`).join('');
});
window.__kitReady = document.fonts.ready.then(() => true);
