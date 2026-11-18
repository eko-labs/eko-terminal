import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadChain } from '../src/chains/index.js';
import { buildServer, pickEncoding } from '../src/server.js';
import type { Edge } from '../src/service.js';

// The static block and the compression hook need only the chain's wording from the edge.
const edge = { chain: loadChain('robinhood') } as unknown as Edge;

function dists() {
  const root = mkdtempSync(join(tmpdir(), 'eko-static-'));
  const web = join(root, 'web'), landing = join(root, 'landing');
  const bundle = 'export const x = "' + 'eko '.repeat(2000) + '";\n';
  for (const dir of [join(web, 'assets'), join(web, 'fonts'), join(landing, 'assets'), join(landing, 'media')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(web, 'index.html'), `<!doctype html><title>EKO</title><!--eko:head--><p>${'terminal '.repeat(300)}</p>`);
  writeFileSync(join(web, 'assets', 'index-abc123.js'), bundle);
  writeFileSync(join(web, 'assets', 'index-abc123.js.br'), brotliCompressSync(bundle));
  writeFileSync(join(web, 'fonts', 'syne-regular.ttf'), 'font');
  writeFileSync(join(landing, 'index.html'), `<!doctype html><title>EKO</title><p>${'landing '.repeat(300)}</p>`);
  writeFileSync(join(landing, 'media', 'clip.mp4'), 'video');
  return { webDist: web, landingDist: landing };
}

describe('static serving and compression', () => {
  it('picks br, then gzip, and honours q=0', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip;q=0.8')).toBe('gzip');
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
    expect(pickEncoding('*')).toBe('br');
  });

  it('serves the build\'s precompressed files, compresses HTML and JSON, and caches by kind', async () => {
    const app = buildServer(edge, dists());
    const asset = await app.inject({ url: '/assets/index-abc123.js', headers: { 'accept-encoding': 'gzip, br' } });
    expect(asset.headers['content-encoding']).toBe('br');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(brotliDecompressSync(asset.rawPayload).toString()).toContain('export const x');

    const plain = await app.inject({ url: '/assets/index-abc123.js' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.payload).toContain('export const x');

    const font = await app.inject({ url: '/fonts/syne-regular.ttf' });
    expect(font.headers['cache-control']).toMatch(/max-age=2592000/);
    const media = await app.inject({ url: '/site/media/clip.mp4', headers: { 'accept-encoding': 'br' } });
    expect(media.headers['cache-control']).toMatch(/max-age=2592000/);
    expect(media.headers['content-encoding']).toBeUndefined();

    const landing = await app.inject({ url: '/', headers: { 'accept-encoding': 'gzip' } });
    expect(landing.headers['content-encoding']).toBe('gzip');
    expect(landing.headers.vary).toMatch(/accept-encoding/i);
    expect(gunzipSync(landing.rawPayload).toString()).toContain('landing landing');
    const shell = await app.inject({ url: '/radar', headers: { 'accept-encoding': 'br' } });
    expect(brotliDecompressSync(shell.rawPayload).toString()).toContain('terminal terminal');

    const small = await app.inject({ url: '/v1/nothing-here', headers: { 'accept-encoding': 'br' } });
    expect(small.statusCode).toBe(404);
    expect(small.headers['content-encoding']).toBeUndefined();
    await app.close();
  });

  it('puts the public config in the terminal page, escaped, so the first render does not wait for /v1/config', async () => {
    const app = buildServer(edge, dists());
    const page = (await app.inject({ url: '/radar' })).payload;
    const json = /<script id="eko-config" type="application\/json">(.*?)<\/script>/.exec(page)?.[1];
    expect(json).toBeDefined();
    expect(json).not.toContain('<');
    expect(JSON.parse(json!)).toEqual((await app.inject({ url: '/v1/config' })).json());
  });

  it('serves the landing documentation and whitepaper as HTML entries', async () => {
    const dist = dists();
    const pages = { 'docs.html': '<title>EKO Docs</title>', 'whitepaper.html': '<title>EKO Whitepaper</title>' };
    for (const [file, title] of Object.entries(pages)) writeFileSync(join(dist.landingDist, file), title);
    const app = buildServer(edge, dist);
    try {
      for (const [file, title] of Object.entries(pages)) {
        const response = await app.inject({ url: `/site/${file}` });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toMatch(/^text\/html/);
        expect(response.headers['cache-control']).toBe('no-cache');
        expect(response.payload).toBe(title);
      }
    } finally {
      await app.close();
      rmSync(dirname(dist.landingDist), { recursive: true, force: true });
    }
  });
});
