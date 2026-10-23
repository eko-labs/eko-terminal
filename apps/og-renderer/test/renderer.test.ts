import { describe, expect, it, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUYER_RISK, DYOR, NON_AFFILIATION } from '@eko/shared';
import { OgRenderer, cardLayout, createOgRenderer, fontContentHash, satoriRasterizer, verdictColour, type CardNode, type ShareCard } from '../src/index.js';
import { RenderWorker, loadBrandAssets } from '../src/runtime.js';

const card: ShareCard = { title: 'Buyer risk snapshot', label: 'Not fully checked', gap: 'Coverage unavailable',
  details: ['Agent share (beta): unavailable', 'Exit cost: unavailable'], block: '120', receipt: 'sample-receipt' };
// Adapter-contract fixture only: PNG header, not satori/resvg raster output or live image evidence.
export function pngHeader(width: number, height: number) {
  const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
}
const textContent = (node: CardNode): string => typeof node.props.children === 'string' ? node.props.children
  : (node.props.children ?? []).map(textContent).join('');
const nodes = (node: CardNode): CardNode[] => [node, ...(Array.isArray(node.props.children) ? node.props.children.flatMap(nodes) : [])];
describe('deterministic public share rendering', () => {
  it('clips hostile and oversized source text; preserves complete footer disclosures in both formats', () => {
    for (const format of ['share', 'reply'] as const) {
      const layout = cardLayout({ ...card, name: '<script>\u202ehttps://hostile.example ' + 'x'.repeat(10000), symbol: '<a>\u0000BAD' }, format);
      const text = textContent(layout.node);
      expect([layout.width, layout.height]).toEqual([1200, format === 'share' ? 630 : 675]);
      expect(text).toContain(BUYER_RISK); expect(text).toContain(DYOR); expect(text).toContain(NON_AFFILIATION); expect(text).toContain('Live status; can change');
      expect(text).toContain('Block 120'); expect(text).toContain('sample-receipt'); expect(text).toContain('Coverage unavailable');
      expect(text).not.toMatch(/https:|<script>|<a>|\u202e/); expect(text.length).toBeLessThan(4500);
      expect(text).not.toContain('x'.repeat(45));
      const disclosures = nodes(layout.node).filter(node => [BUYER_RISK, DYOR, NON_AFFILIATION, 'Live status; can change'].includes(String(node.props.children)));
      expect(disclosures).toHaveLength(4);
      expect(disclosures.every(node => Number(node.props.style.fontSize) >= 18)).toBe(true);
    }
  });
  it('hashes projected content, format and font bytes; deduplicates concurrent requests by content', async () => {
    const raster = vi.fn(async (_node: unknown, width: number, height: number) => pngHeader(width, height));
    const renderer = new OgRenderer(raster, 'sample-font-hash');
    const [a, b] = await Promise.all([renderer.render(card), renderer.render({ ...card })]);
    expect(a.contentHash).toBe(b.contentHash); expect(a.imageHash).toBe(b.imageHash); expect(a.png).toEqual(b.png);
    expect(raster).toHaveBeenCalledTimes(1);
    const reply = await renderer.render(card, 'reply'); expect(reply.contentHash).not.toBe(a.contentHash);
    expect(reply.imageHash).not.toBe(a.imageHash); expect(reply.height).toBe(675);
    expect((await renderer.render({ ...card, block: '121' })).contentHash).not.toBe(a.contentHash);
    expect((await new OgRenderer(raster, 'other-font-hash').render(card)).contentHash).not.toBe(a.contentHash);
  });
  it('retries failures and rejects incorrect dimensions or non-PNG output', async () => {
    const raster = vi.fn().mockResolvedValueOnce(pngHeader(1, 1)).mockResolvedValueOnce(Buffer.from('no image')).mockResolvedValue(pngHeader(1200, 630));
    const renderer = new OgRenderer(raster, 'fonts');
    await expect(renderer.render(card)).rejects.toThrow('Invalid share PNG');
    await expect(renderer.render(card)).rejects.toThrow('Invalid share PNG');
    expect((await renderer.render(card)).width).toBe(1200);
  });
  it('supplies brand fonts to satori and disables system fonts in resvg', async () => {
    const fonts = [{ name: 'Syne', data: Buffer.from('font fixture'), weight: 400 as const, style: 'normal' as const }];
    const satori = vi.fn(async () => '<svg/>'), resvg = vi.fn();
    class Resvg { constructor(svg: string, options: unknown) { resvg(svg, options); } render() { return { asPng: () => pngHeader(1200, 630) }; } }
    const layout = cardLayout(card);
    await satoriRasterizer(satori, Resvg, fonts)(layout.node, layout.width, layout.height);
    expect(satori).toHaveBeenCalledWith(layout.node, { width: 1200, height: 630, fonts });
    expect(resvg).toHaveBeenCalledWith('<svg/>', { font: { loadSystemFonts: false } });
    expect(fontContentHash(fonts)).toBe(fontContentHash(fonts));
    expect(fontContentHash(fonts, [Buffer.from('brand fixture')])).not.toBe(fontContentHash(fonts));
    expect(fontContentHash(fonts, [Buffer.from('brand fixture')])).not.toBe(fontContentHash(fonts, [Buffer.from('changed brand fixture')]));
    expect(fontContentHash([{ ...fonts[0], data: Buffer.from('different fixture') }])).not.toBe(fontContentHash(fonts));
  });
  it('renders real decoded PNGs in both sizes, byte-identical across independent workers', async () => {
    const a = await createOgRenderer(), b = await createOgRenderer();
    const hostile = { ...card, name: '<script>\u202ehttps://hostile.example ' + 'x'.repeat(10000), symbol: '<a>\u0000BAD' };
    try {
      for (const label of ['Clear', 'Monitor', 'Danger', 'Not fully checked']) {
        for (const format of ['share', 'reply'] as const) {
          const [first, second] = await Promise.all([a.render({ ...hostile, label }, format), b.render({ ...hostile, label }, format)]);
          expect(first.png).toEqual(second.png); expect(first.imageHash).toBe(second.imageHash);
          expect(first.png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          expect(first.png.readUInt32BE(16)).toBe(1200); expect(first.png.readUInt32BE(20)).toBe(format === 'share' ? 630 : 675);
          expect(first.png[24]).toBe(8); expect(first.png[25]).toBe(6); // 8-bit RGBA
          const chunks: Buffer[] = [];
          let offset = 8, ended = false;
          while (offset < first.png.length) {
            const length = first.png.readUInt32BE(offset), kind = first.png.toString('ascii', offset + 4, offset + 8);
            if (kind === 'IDAT') chunks.push(first.png.subarray(offset + 8, offset + 8 + length));
            if (kind === 'IEND') ended = true;
            offset += length + 12;
          }
          const pixels = inflateSync(Buffer.concat(chunks));
          expect(pixels.length).toBe((1200 * 4 + 1) * first.height);
          expect(new Set(pixels).size).toBeGreaterThan(100); expect(ended).toBe(true);
          expect(offset).toBe(first.png.length);
        }
      }
    } finally { await Promise.all([a.close(), b.close()]); }
  }, 20000);
  it('embeds bounded local brand data and applies sober verdict and agent-flow colours', async () => {
    const brand = await loadBrandAssets();
    expect(brand.bytes).toHaveLength(4);
    expect(brand.bytes.every(data => data.length <= 512 * 1024)).toBe(true);
    expect(brand.assets.mark).toBe('data:image/png;base64,' + brand.bytes[0].toString('base64'));
    expect(brand.assets.ghost).toBe('data:image/png;base64,' + brand.bytes[2].toString('base64'));
    for (const [label, colour] of [['Clear', '#8fcaf0'], ['Monitor', '#d6ecfa'], ['Danger', '#f08c7e'], ['Not fully checked', '#94a9b8']]) {
      const layout = cardLayout({ ...card, label }, 'share', brand.assets);
      expect(verdictColour(label)).toBe(colour);
      const all = nodes(layout.node);
      expect(all.find(node => node.props.children === label)?.props.style.color).toBe(colour);
      const images = all.filter(node => node.type === 'img');
      expect(images.every(node => node.props.src?.startsWith('data:image/'))).toBe(true);
      expect(images.some(node => node.props.src === brand.assets.mark)).toBe(true);
      expect(images.some(node => node.props.src === brand.assets.ghost)).toBe(label === 'Not fully checked');
      expect(all.find(node => node.props.children === 'unavailable' && node.props.style.color === '#8fcaf0')).toBeDefined();
    }
    expect(verdictColour('Legacy assessment · CLEAR')).toBe('#8fcaf0');
    expect(verdictColour('High risk · Candidate')).toBe('#f08c7e');
    expect(verdictColour('Scan pending · Lower observed risk')).toBe('#94a9b8');
    const directory = await mkdtemp(join(tmpdir(), 'eko-og-assets-'));
    try {
      for (const file of ['eko-mark-stipple-512.png', 'eko-lockup-stipple-960.png', 'eko-ghost-stipple-512.png', 'eko-mark-tight.svg']) {
        await writeFile(join(directory, file), Buffer.alloc(512 * 1024 + 1));
      }
      await expect(loadBrandAssets(pathToFileURL(directory + '/'))).rejects.toThrow('Invalid brand asset size');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('bounds completed cache entries and bytes, evicts LRU, and bounds unique pending work', async () => {
    const raster = vi.fn(async (_node: unknown, width: number, height: number) => pngHeader(width, height));
    const renderer = new OgRenderer(raster, 'fonts', { maxEntries: 2, maxBytes: 48, maxPending: 2 });
    await renderer.render(card); await renderer.render({ ...card, block: '121' }); await renderer.render(card);
    await renderer.render({ ...card, block: '122' });
    expect(renderer.cacheStats).toEqual({ entries: 2, bytes: 48, pending: 0 });
    await renderer.render({ ...card, block: '121' }); expect(raster).toHaveBeenCalledTimes(4);
    const bytes = new OgRenderer(raster, 'fonts', { maxEntries: 128, maxBytes: 24, maxPending: 2 });
    await bytes.render(card); await bytes.render({ ...card, block: '121' });
    expect(bytes.cacheStats.entries).toBe(1); expect(bytes.cacheStats.bytes).toBe(24);
    let finish!: (value: Uint8Array) => void;
    const stalled = new OgRenderer(() => new Promise(resolve => { finish = resolve; }), 'fonts', { maxEntries: 2, maxBytes: 48, maxPending: 1 });
    const first = stalled.render(card), duplicate = stalled.render(card);
    await expect(stalled.render({ ...card, block: '121' })).rejects.toThrow('og_renderer_busy');
    finish(pngHeader(1200, 630)); await Promise.all([first, duplicate]);
    await stalled.close(); await expect(stalled.render(card)).rejects.toThrow('og_renderer_unavailable');
  });
  it('terminates stalled worker work at deadline, rejects bursts, and recovers after failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eko-og-worker-'));
    const file = join(directory, 'worker.mjs');
    await writeFile(file, "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => { while (true) {} });");
    const worker = new RenderWorker([], 500, 1, pathToFileURL(file));
    const layout = cardLayout(card);
    try {
      const first = worker.rasterize(layout.node, layout.width, layout.height);
      const queued = worker.rasterize(layout.node, layout.width, layout.height);
      const rejected = Promise.all([expect(first).rejects.toThrow('og_renderer_timeout'), expect(queued).rejects.toThrow('og_renderer_timeout')]);
      await expect(worker.rasterize(layout.node, layout.width, layout.height)).rejects.toThrow('og_renderer_busy');
      await rejected;
      await writeFile(file, "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => parentPort.postMessage({ png: new Uint8Array([1, 2, 3]) }));");
      expect(await worker.rasterize(layout.node, layout.width, layout.height)).toEqual(new Uint8Array([1, 2, 3]));
    } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
