import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

// Resolve from the deployed renderer workspace, retaining exact pinned native dependencies.
const localRequire = createRequire(import.meta.url);
const require = createRequire(localRequire.resolve('@eko/og-renderer'));
const { default: satori } = require('satori');
const { Resvg } = require('@resvg/resvg-js');
const fonts = workerData.fonts.map(font => ({ ...font, data: Buffer.from(font.data) }));
// No network assets or system fonts. Missing glyphs remain local fallback glyphs.
globalThis.fetch = async () => { throw new Error('Remote assets disabled'); };
parentPort.on('message', async ({ node, width, height }) => {
  try {
    const svg = await satori(node, { width, height, fonts, embedFont: true });
    const png = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
    parentPort.postMessage({ png });
  } catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : 'og_renderer_unavailable' }); }
});
