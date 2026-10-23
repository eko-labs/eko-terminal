import { createHash } from 'node:crypto';
import { DYOR, NON_AFFILIATION, BUYER_RISK, guardInertText } from '@eko/shared';
import { toUntrusted } from '@eko/untrusted';

/** Deliberately narrow public projection; no raw card, journal or wallet report. */
export interface ShareCard {
  title: string;
  name?: string;
  symbol?: string;
  label: string;
  gap: string;
  details: string[];
  block: string;
  receipt: string;
}
export type CardFormat = 'share' | 'reply';
export interface CardNode { type: 'div' | 'img'; props: { style: Record<string, string | number>; children?: string | CardNode[]; src?: string; width?: number; height?: number } }
export interface BrandAssets { mark: string; ghost: string }
export interface BrandFont { name: string; data: Buffer; weight: 400 | 600; style: 'normal' }
export type Satori = (node: CardNode, options: { width: number; height: number; fonts: BrandFont[] }) => Promise<string>;
export type ResvgConstructor = new (svg: string, options: { font: { loadSystemFonts: false } }) => { render(): { asPng(): Uint8Array } };
export type Rasterizer = (node: CardNode, width: number, height: number) => Promise<Uint8Array>;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const clipped = (text: string, max: number) => toUntrusted(text.slice(0, 4096), max).text;
const box = (style: CardNode['props']['style'], children: string | CardNode[]): CardNode => ({
  type: 'div', props: { style: { display: 'flex', flexShrink: 0, overflow: 'hidden', ...style }, children },
});
const picture = (src: string, width: number, height: number, style: CardNode['props']['style'] = {}): CardNode => ({
  type: 'img', props: { src, width, height, style },
});
const palette = { ink: '#e8f2f8', ink2: '#b9cad6', muted: '#94a9b8', clear: '#8fcaf0', monitor: '#d6ecfa', danger: '#f08c7e' };
export function verdictColour(label: string) {
  if (/not fully checked|unavailable|pending|scan (queued|running|failed)/i.test(label)) return palette.muted;
  if (/^(danger|high risk)\b|^Legacy assessment · DANGER$/i.test(label)) return palette.danger;
  if (/^(monitor|elevated risk)\b|^Legacy assessment · MONITOR$/i.test(label)) return palette.monitor;
  if (/^(clear|no flags|lower observed risk)\b|^Legacy assessment · CLEAR$/i.test(label)) return palette.clear;
  return palette.muted;
}
// A fixed seed and integer PRNG keep the local SVG grain identical on every worker.
let grainSeed = 4663;
const dots = Array.from({ length: 240 }, () => {
  grainSeed = (Math.imul(grainSeed, 1664525) + 1013904223) >>> 0;
  const x = grainSeed % 1200;
  grainSeed = (Math.imul(grainSeed, 1664525) + 1013904223) >>> 0;
  return `<circle cx="${x}" cy="${grainSeed % 675}" r="1"/>`;
}).join('');
const motif = 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><g fill="#8fcaf0" opacity="0.08">${dots}</g><g fill="none" stroke="#223341" opacity="0.35">${[160, 220, 280, 340].map(r => `<circle cx="1130" cy="120" r="${r}"/>`).join('')}</g></svg>`).toString('base64');

// Equal-width local glyph cells give block/receipt IDs a mono rhythm without system fonts.
const mono = (text: string) => box({ fontSize: 18, height: 25, color: palette.ink2 }, Array.from(text).map(char =>
  box({ width: 12, justifyContent: 'center', overflow: 'visible' }, char)));

export function cardLayout(card: ShareCard, format: CardFormat = 'share', assets?: BrandAssets) {
  const height = format === 'reply' ? 675 : 630;
  const label = clipped(card.label, 90), colour = verdictColour(label);
  const unchecked = /not fully checked|unavailable|pending|scan (queued|running|failed)/i.test(label);
  const block = `Block ${clipped(card.block, 24)}`, receipt = `Receipt ${clipped(card.receipt, 82)}`;
  const stackedIds = block.length + receipt.length > 88;
  const details = card.details.slice(0, 3).map(text => clipped(text, 180));
  const metrics = details.every(text => /^(Top playbook|Agent share|Exit cost)[^:]*:/.test(text));
  const children: CardNode[] = [
    picture(motif, 1200, 675, { position: 'absolute', left: 0, top: 0 }),
    box({ position: 'absolute', left: 48, top: 28, height: 88, alignItems: 'center', gap: 20 }, [
      ...(assets ? [picture(assets.mark, 88, 88)] : []),
      box({ fontSize: 50, fontWeight: 600, letterSpacing: -2 }, 'EKO'),
    ]),
    box({ position: 'absolute', right: 48, top: 50, width: 580, height: 60, justifyContent: 'flex-end', textAlign: 'right', fontSize: 24, color: palette.muted }, clipped(card.title, 60)),
    box({ position: 'absolute', left: 48, top: 126, width: 1104, height: 40, fontSize: 32, fontWeight: 600 },
      [clipped(card.name ?? '', 44), clipped(card.symbol ?? '', 16)].filter(Boolean).join(' · ')),
    box({ position: 'absolute', left: 48, top: 177, width: 1000, height: 78, fontSize: label.length > 32 ? 36 : 58, fontWeight: 600, color: colour, lineHeight: 1.05 }, label),
    ...(assets && unchecked ? [picture(assets.ghost, 100, 100, { position: 'absolute', right: 48, top: 162, opacity: 0.18 })] : []),
    box({ position: 'absolute', left: 48, top: 264, width: 1104, height: 48, fontSize: 20, color: palette.ink2, lineHeight: 1.2 }, clipped(card.gap, 160)),
    box({ position: 'absolute', left: 48, top: 326, width: 1104, height: 104, backgroundColor: '#03080c', borderTop: '1px solid #223341', borderBottom: '1px solid #142029',
      flexDirection: 'row' }, details.map((text, index) => {
      if (!metrics) return box({ width: 368, height: 102, padding: '6px 12px', fontSize: 18, lineHeight: 1, color: palette.ink2,
        borderLeft: index ? '1px solid #142029' : '0px solid #142029' }, text);
      const colon = text.indexOf(':'), heading = text.slice(0, colon), value = text.slice(colon + 1).trim();
      const confidence = heading.startsWith('Agent share') ? value.indexOf(' · confidence') : -1;
      const main = confidence < 0 ? value : value.slice(0, confidence);
      return box({ width: 368, padding: '10px 16px', flexDirection: 'column', borderLeft: index ? '1px solid #142029' : '0px solid #142029', gap: 4 }, [
        box({ height: 23, fontSize: 18, color: palette.muted }, heading),
        box({ height: confidence < 0 ? 50 : 30, fontSize: main.length > 32 ? 20 : 26, lineHeight: 1.15, fontWeight: 600, color: heading.startsWith('Agent share') ? '#8fcaf0' : palette.ink }, main),
        ...(confidence < 0 ? [] : [box({ height: 23, fontSize: 18, color: palette.ink2 }, value.slice(confidence + 3))]),
      ]);
    })),
    box({ position: 'absolute', left: 48, top: height - 196, width: 1104, height: 50, flexDirection: stackedIds ? 'column' : 'row', gap: stackedIds ? 0 : 20 }, [
      mono(block), mono(receipt),
    ]),
    box({ position: 'absolute', left: 48, top: height - 140, width: 1104, height: 114, paddingTop: 10, borderTop: '1px solid #223341', flexDirection: 'column', color: palette.ink2 }, [
      ...['Live status; can change', BUYER_RISK, DYOR, NON_AFFILIATION].map(text =>
        box({ height: 26, fontSize: 18, lineHeight: 1.2 }, text)),
    ]),
  ];
  const node = box({ position: 'relative', flexDirection: 'column', width: 1200, height,
    backgroundColor: '#040d14', color: palette.ink, fontFamily: 'Syne' }, children);
  return { node, width: 1200, height };
}

/** System fonts and network assets are disabled; satori embeds the supplied brand glyphs. */
export function satoriRasterizer(satori: Satori, Resvg: ResvgConstructor, fonts: BrandFont[]): Rasterizer {
  if (!fonts.length) throw new Error('Brand fonts required');
  return async (node, width, height) => new Resvg(await satori(node, { width, height, fonts }),
    { font: { loadSystemFonts: false } }).render().asPng();
}

export class OgRenderer {
  private readonly cache = new Map<string, RenderedCard>();
  constructor(private readonly rasterize: Rasterizer, private readonly fontHash: string,
    private readonly limits = { maxEntries: 128, maxBytes: 32 * 1024 * 1024, maxPending: 9 },
    private readonly dispose: () => Promise<void> = async () => {}, private readonly assets?: BrandAssets) {
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new RangeError('Invalid renderer bounds');
  }
  private readonly inFlight = new Map<string, Promise<RenderedCard>>();
  private bytes = 0;
  private closed = false;
  get cacheStats() { return { entries: this.cache.size, bytes: this.bytes, pending: this.inFlight.size }; }
  async close() { this.closed = true; this.cache.clear(); this.bytes = 0; await this.dispose(); }
  render(card: ShareCard, format: CardFormat = 'share') {
    const layout = cardLayout(card, format, this.assets);
    if (this.closed) return Promise.reject(new Error('og_renderer_unavailable'));
    const contentHash = hash(JSON.stringify({ version: 3, fontHash: this.fontHash, ...layout }));
    const cached = this.cache.get(contentHash);
    if (cached) { this.cache.delete(contentHash); this.cache.set(contentHash, cached); return Promise.resolve(cached); }
    const active = this.inFlight.get(contentHash); if (active) return active;
    if (this.inFlight.size >= this.limits.maxPending) return Promise.reject(new Error('og_renderer_busy'));
    const pending = (async () => {
      const png = Buffer.from(await this.rasterize(layout.node, layout.width, layout.height));
      // Refuse a substitute image or wrong dimensions, including rasterizer fixture mistakes.
      if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== layout.width || png.readUInt32BE(20) !== layout.height)
        throw new Error('Invalid share PNG');
      const result = { png, contentHash, imageHash: hash(png), width: layout.width, height: layout.height };
      if (!this.closed && png.length <= this.limits.maxBytes) {
        while (this.cache.size && (this.cache.size >= this.limits.maxEntries || this.bytes + png.length > this.limits.maxBytes)) {
          const oldest = this.cache.keys().next().value!;
          const entry = this.cache.get(oldest)!;
          this.bytes -= entry.png.length; this.cache.delete(oldest);
        }
        this.cache.set(contentHash, result); this.bytes += png.length;
      }
      return result;
    })();
    // TODO(spec): §15.6 leaves retention unspecified. Use an LRU capped at 128 images / 32 MiB.
    this.inFlight.set(contentHash, pending);
    void pending.finally(() => { this.inFlight.delete(contentHash); }).catch(() => {});
    return pending;
  }
}

export interface RenderedCard { png: Buffer; contentHash: string; imageHash: string; width: number; height: number }

export { createOgRenderer } from './runtime.js';

export const fontContentHash = (fonts: BrandFont[], assets: Uint8Array[] = []) => hash(Buffer.concat([...fonts.map(font => Buffer.concat([
  Buffer.from(guardInertText(`${font.name}/${font.weight}/${font.style}`)), font.data,
])), ...assets]));
