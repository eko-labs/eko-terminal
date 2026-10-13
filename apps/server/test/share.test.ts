import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOgRenderer, OgRenderer, type CardNode } from '@eko/og-renderer';
import { DYOR, NON_AFFILIATION } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { bagShares } from '../src/db/schema.js';
import { ShareService, registerShareRoutes } from '../src/http/share.js';
import { redactBagReport } from '../src/read/bags.js';
import { seedReadFixture } from './read-fixture.js';

let built: Awaited<ReturnType<typeof buildApp>>, directory: string, scanId: string, coin: string, bagId: string;
const origin = 'https://app.eko.example';
const textContent = (node: CardNode): string => typeof node.props.children === 'string' ? node.props.children
  : (node.props.children ?? []).map(textContent).join('');
const raster = vi.fn(async (_node: CardNode, width: number, height: number) => {
  // Header-only adapter fixture, not real PNG rendering evidence.
  const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
});
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'eko-share-fixture-'));
  await writeFile(join(directory, 'index.html'), await readFile(new URL('../../web/index.html', import.meta.url)));
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'fixture-placeholder'.repeat(3),
    PUBLIC_ORIGIN: origin, SERVE_WEB: 'true', WEB_DIST_DIR: directory, LEGACY_API: 'false', RUN_WORKER: 'false', MARKET_DATA_SOURCE: 'onchain' }),
  { startBackground: false, ogRenderer: new OgRenderer(raster, 'fixture-font-hash') });
  const card = await seedReadFixture(built.ctx.dbh.chain); coin = card.identity.address;
  card.identity.name.text = '<script>hostile-name</script>'; card.identity.symbol.text = 'hostile-symbol';
  vi.spyOn(built.ctx.reads.coins, 'card').mockResolvedValue(card);
  const scan = await built.ctx.reads.scan.scan(coin); scanId = scan.id;
  vi.spyOn(built.ctx.reads.scan, 'get').mockImplementation(async id => id === scanId ? { ...scan, card } : undefined);
  const snapshot = redactBagReport({ wallet: `0x${'b'.repeat(40)}`, asOfBlock: 120, summary: { coins: 1, flagged: 0, danger: 0, valueUsd: 98765 },
    holdings: [{ coin: { address: card.identity.address, name: card.identity.name, symbol: card.identity.symbol, launchpad: 'pons', stage: 'curve',
      verdict: 'pending', verdictPending: true, ageSec: 0, priceUsd: 77, change1hPct: 0, liquidityUsd: 88 },
      balance: '1234567', valueUsd: 98765, status: 'pending', playbooks: [], exitCost1kPct: null }] }, { includeValues: false, includeWallet: false });
  bagId = '11111111-1111-4111-8111-111111111111'; await built.ctx.dbh.db.insert(bagShares).values({ id: bagId, snapshot });
  vi.spyOn(built.ctx.receipts, 'get').mockImplementation(async id => ['private-fixture', 'verdict:sample-revision'].includes(id) ? {
    id, status: 'pending', kind: 'harness_private', hash: `0x${'a'.repeat(64)}`, leaf: `0x${'a'.repeat(64)}`, canonicalization: 'jcs-rfc8785/v1',
    payload: { journal: 'private-journal-fixture', salt: 'private-salt-fixture', key: 'private-key-fixture' },
  } as never : null);
});
afterAll(async () => { vi.restoreAllMocks(); await built?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

describe('public SPA metadata and OG HTTP routes (offline adapter fixtures)', () => {
  it('injects scan unfurl tags in the head once, excluding token names and request-controlled origins', async () => {
    const result = await built.app.inject({ url: `/scan/${scanId}?wallet=private-fixture`, headers: { host: 'hostile.example', 'x-forwarded-host': 'hostile.example', cookie: 'eko_sid=fixture' } });
    expect(result.statusCode).toBe(200); expect(result.headers['content-type']).toContain('text/html');
    expect(result.body).toContain(`property="og:url" content="${origin}/scan/${scanId}"`);
    expect(result.body).toContain(`property="og:image" content="${origin}/og/scan/${scanId}.png"`);
    expect(result.body).toContain('name="twitter:card" content="summary_large_image"');
    expect(result.body.match(/<title>/g)).toHaveLength(1); expect(result.body).not.toContain('<!--eko:head-->');
    for (const key of ['description', 'og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image',
      'og:image:width', 'og:image:height', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
      expect(result.body.match(new RegExp(`(?:name|property)="${key}"`, 'g'))).toHaveLength(1);
    }
    expect(result.body.match(/name="theme-color" content="#05121c"/g)).toHaveLength(1);
    for (const href of ['/favicon.svg', '/manifest.webmanifest', '/icons/eko-192.png']) {
      expect(result.body.match(new RegExp(`href="${href}"`, 'g'))).toHaveLength(1);
    }
    expect(result.body).toContain('<div id="root"></div>');
    expect(result.body).toContain('src="/src/main.tsx"');
    for (const value of ['hostile.example', 'hostile-name', 'hostile-symbol', 'private-fixture']) expect(result.body).not.toContain(value);
    expect(result.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(result.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(result.headers['content-security-policy']).not.toContain('hostile');
    expect(result.body).toContain('Not financial advice'); expect(result.body).toContain('Not affiliated with');
    const inApp = await built.app.inject(`/v1/share-meta?path=${encodeURIComponent(`/scan/${scanId}`)}`);
    expect(inApp.json().title).toBe('EKO · Buyer risk snapshot'); expect(inApp.json().image).toBe(`${origin}/og/scan/${scanId}.png`);
  });
  it('renders only persisted redacted bags, preserving pending/unavailable labels and footers', async () => {
    const html = await built.app.inject(`/bags/r/${bagId}`), image = await built.app.inject(`/og/bags/${bagId}.png`);
    expect(html.body).toContain('EKO · Shared bag report'); expect(html.headers['cache-control']).toBe('public, max-age=300');
    expect(image.statusCode).toBe(200); expect(image.headers['content-type']).toContain('image/png');
    const text = textContent(raster.mock.calls.at(-1)![0]);
    expect(text).toContain('PENDING'); expect(text).toContain('unavailable'); expect(text).toContain('Block 120');
    expect(text).toContain('Agent share: unavailable'); expect(text).toContain('No matching playbook');
    expect(text).toContain(DYOR); expect(text).toContain(NON_AFFILIATION);
    for (const privateValue of ['b'.repeat(40), '98765', '1234567', '77', '88']) expect(html.body + text).not.toContain(privateValue);
  });
  it('uses conditional ETags and distinct reply dimensions without freezing mutable scans', async () => {
    const image = await built.app.inject(`/og/scan/${scanId}.png`);
    expect(image.statusCode).toBe(200); expect(image.rawPayload.readUInt32BE(16)).toBe(1200); expect(image.rawPayload.readUInt32BE(20)).toBe(630);
    const same = await built.app.inject({ url: `/og/scan/${scanId}.png`, headers: { 'if-none-match': image.headers.etag! } });
    expect(same.statusCode).toBe(304); expect(same.body).toBe('');
    const reply = await built.app.inject(`/og/scan/${scanId}.png?format=reply`);
    expect(reply.rawPayload.readUInt32BE(20)).toBe(675); expect(reply.headers.etag).not.toBe(image.headers.etag);
    expect((await built.app.inject(`/og/scan/${scanId}.png?format=hostile`)).statusCode).toBe(400);
  });
  it('keeps private receipt metadata at status-only, and applies per-path policies', async () => {
    const receipt = await built.app.inject('/receipt/private-fixture');
    expect(receipt.body).toContain('Receipt pending'); expect(receipt.headers['cache-control']).toBe('no-store');
    for (const value of ['private-journal-fixture', 'private-salt-fixture', 'private-key-fixture', 'harness_private']) expect(receipt.body).not.toContain(value);
    for (const path of ['/receipt/verdict:sample-revision', '/receipt/verdict%3Asample-revision']) {
      const publicReceipt = await built.app.inject(path);
      expect(publicReceipt.body).toContain(`href="${origin}/receipt/verdict%3Asample-revision"`);
      expect(publicReceipt.body).toContain('Receipt pending');
      expect(built.ctx.receipts.get).toHaveBeenLastCalledWith('verdict:sample-revision');
    }
    expect((await built.app.inject(`/coin/${coin}`)).body).toContain(`${origin}/coin/${coin}`);
    for (const url of ['/', '/index.html', '/bags', '/mission/agents/sample-agent']) {
      const result = await built.app.inject(url); expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('private, no-store'); expect(result.body).not.toContain('og:url');
      for (const key of ['description', 'og:type', 'og:site_name', 'og:title', 'og:description', 'twitter:card']) {
        expect(result.body.match(new RegExp(`(?:name|property)="${key}"`, 'g'))).toHaveLength(1);
      }
      expect(result.body).toContain('<!--eko:head-->');
      expect(result.body).toContain('name="theme-color" content="#05121c"');
      expect(result.body).toContain('href="/manifest.webmanifest"');
      expect(result.body).toContain('href="/icons/eko-192.png"');
    }
    expect((await built.app.inject('/embed/sample')).headers['content-security-policy']).toContain('frame-ancestors *');
    expect((await built.app.inject('/og/scan/invalid.png')).statusCode).toBe(404);
    expect((await built.app.inject('/v2/unknown')).statusCode).toBe(404);
    expect((await built.app.inject('/v1/share-meta?path=%2Fwallets%2Ffixture%2Fbags')).statusCode).toBe(404);
  });
  it('does not advertise or fabricate images without the spec-named rasterizer', async () => {
    const shares = new ShareService(origin, { scan: built.ctx.reads.scan, coins: built.ctx.reads.coins,
      bags: { publicReport: async () => null }, receipts: built.ctx.receipts });
    const app = Fastify(); await registerShareRoutes(app, shares);
    try {
      const meta = await app.inject(`/v1/share-meta?path=${encodeURIComponent(`/scan/${scanId}`)}`);
      expect(meta.json().image).toBeUndefined();
      const image = await app.inject(`/og/scan/${scanId}.png`);
      expect(image.statusCode).toBe(503); expect(image.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
  it('serves real scan/bag PNGs and explicit pending or missing-data states', async () => {
    const renderer = await createOgRenderer();
    const pendingId = `scan-${'f'.repeat(64)}`;
    const shares = new ShareService(origin, { scan: { get: async id => id === pendingId ? {
      id, status: 'pending', shareUrl: `/scan/${id}`,
    } : built.ctx.reads.scan.get(id) }, coins: built.ctx.reads.coins,
    bags: { publicReport: async id => id === bagId ? (await built.ctx.dbh.db.select().from(bagShares))[0].snapshot : null }, receipts: built.ctx.receipts }, renderer);
    const app = Fastify(); await registerShareRoutes(app, shares);
    try {
      const pendingCard = (await shares.content(`/scan/${pendingId}`))!.card!;
      expect(pendingCard.label).toContain('Scan pending'); expect(pendingCard.gap).toBe('Coverage unavailable');
      expect(pendingCard.details).toEqual(['Top playbook: unavailable', 'Agent share (beta): unavailable · confidence unavailable', 'Exit cost: unavailable in this share projection']);
      const pendingImage = await app.inject(`/og/scan/${pendingId}.png`);
      expect(pendingImage.statusCode).toBe(200); expect(pendingImage.rawPayload.length).toBeGreaterThan(10000);
      for (const kind of ['scan', 'bags']) {
        const id = kind === 'scan' ? scanId : bagId;
        for (const format of ['share', 'reply']) {
          const image = await app.inject(`/og/${kind}/${id}.png?format=${format}`);
          expect(image.statusCode).toBe(200); expect(image.rawPayload.readUInt32BE(16)).toBe(1200);
          expect(image.rawPayload.readUInt32BE(20)).toBe(format === 'share' ? 630 : 675);
        }
        const missing = await app.inject(`/og/${kind}/${kind === 'scan' ? `scan-${'e'.repeat(64)}` : '22222222-2222-4222-8222-222222222222'}.png`);
        expect(missing.statusCode).toBe(404); expect(missing.headers['cache-control']).toBe('no-store');
      }
      const spy = vi.spyOn(renderer, 'render').mockRejectedValue(new Error('og_renderer_busy'));
      const busy = await app.inject(`/og/scan/${pendingId}.png`);
      expect(busy.statusCode).toBe(503); expect(busy.json().error).toBe('og_renderer_busy');
      expect(busy.headers['cache-control']).toBe('no-store'); expect(busy.headers['retry-after']).toBe('1');
      spy.mockRejectedValue(new Error('og_renderer_timeout'));
      expect((await app.inject(`/og/scan/${pendingId}.png`)).json().error).toBe('og_renderer_timeout');
    } finally { await app.close(); await renderer.close(); }
  });
  it('retains beta until the supplied flow gate clears and labels empty bags explicitly', async () => {
    const ready = (await built.ctx.reads.scan.get(scanId))!;
    const card = structuredClone(ready.card!);
    const shares = new ShareService(origin, { scan: { get: async () => ({ ...ready, card }) }, coins: built.ctx.reads.coins,
      bags: { publicReport: async () => ({ asOfBlock: 120, summary: { coins: 0, flagged: 0, danger: 0 }, holdings: [] }) }, receipts: built.ctx.receipts });
    card.flow.beta = true;
    expect((await shares.content(`/scan/${scanId}`))!.card!.details[1]).toContain('Agent share (beta):');
    card.flow.beta = false;
    expect((await shares.content(`/scan/${scanId}`))!.card!.details[1]).toContain('Agent share:');
    expect((await shares.content(`/scan/${scanId}`))!.card!.details[1]).not.toContain('(beta)');
    const empty = (await shares.content(`/bags/r/${bagId}`))!.card!;
    expect(empty.details).toEqual(['Verdict: unavailable · no shared holdings', 'Top playbook: unavailable', 'Exit cost: unavailable']);
  });
});
