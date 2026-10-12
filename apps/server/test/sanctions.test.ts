import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDb, runMigrations } from '../src/db/client.js';
import { normalizeWallet, parseSdn } from '../src/sanctions/parser.js';
import { downloadSdn, SanctionsService, SanctionsWorker } from '../src/sanctions/service.js';
import { loadConfig } from '../src/config.js';
import { listedWallet, sdnFixture } from './sanctions-fixture.js';

const day = 86400000;
describe('SDN parser (synthetic fixtures only)', () => {
  it('normalizes EVM addresses, deduplicates and retains other digital currencies', () => {
    expect(parseSdn(sdnFixture())).toEqual({ publishedAt: '2026-10-01T00:00:00.000Z', recordCount: 2, addresses: [listedWallet, 'neutral-bitcoin-fixture'] });
    expect(normalizeWallet(` ${listedWallet.toUpperCase()} `)).toBe(listedWallet);
    for (const bad of ['0x1234', 'not-a-wallet', `0x${'z'.repeat(40)}`]) expect(() => normalizeWallet(bad)).toThrow();
  });
  it('refuses truncated, partial, duplicate, malformed and unexpected exports without recovery', () => {
    const text = sdnFixture();
    for (const bad of [text.slice(0, -15), text.replace('<Record_Count>2', '<Record_Count>3'),
      text.replace('<uid>2', '<uid>1'), text.replace(listedWallet, '0x1234'), text.replace('<Publish_Date>10/01/2026', '<Publish_Date>invalid'),
      text.replace('Digital Currency Address - ETH', 'Digital Currency Address -'), '<html>service error</html>',
      '<!DOCTYPE sdnList [<!ENTITY file SYSTEM "file:///fixture">]>' + text, text.replace('</sdnEntry>', '</sdnList>'),
      text.replaceAll('Digital Currency Address', 'Unknown identifier')]) expect(() => parseSdn(bad)).toThrow();
  });
  it('requires an explicit Treasury HTTPS source and makes no download for invalid URLs', async () => {
    for (const url of ['http://ofac.treasury.gov/sdn.xml', 'https://untrusted.example/sdn.xml', 'https://sample-user:placeholder@ofac.treasury.gov/sdn.xml',
      'https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/Published/sdn.xml', 'https://evil.ofac.treas.gov/sdn.xml'])
      expect(() => loadConfig({ OFAC_SDN_URL: url, PGLITE_DIR: ':memory:' })).toThrow();
    for (const url of ['https://www.treasury.gov/ofac/downloads/sdn.xml', 'https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.xml'])
      expect(loadConfig({ OFAC_SDN_URL: url, PGLITE_DIR: ':memory:' }).OFAC_SDN_URL).toBe(url);
    await expect(downloadSdn('http://example.test')).rejects.toThrow();
  });
});

describe('versioned daily worker and shared screening (offline PGlite)', () => {
  let db: Awaited<ReturnType<typeof openDb>>, screening: SanctionsService;
  let now = Date.parse('2026-10-02T00:00:00Z');
  beforeAll(async () => { db = await openDb({ pgliteDir: ':memory:' }); await runMigrations(db); screening = new SanctionsService(db.chain); });
  afterAll(async () => { await db.close(); });
  const unlisted = `0x${'c'.repeat(40)}`;
  it('refuses absent snapshots and provider failure, without leaking error details', async () => {
    await expect(screening.assertWallet(unlisted)).rejects.toMatchObject({ code: 'stale_data', statusCode: 422 });
    await expect(screening.assertWallet()).rejects.toMatchObject({ code: 'stale_data' });
    const observations = vi.fn();
    await new SanctionsWorker(db.chain, undefined, undefined, () => now, observations).tick();
    expect(observations).toHaveBeenCalledWith(true);
    expect(await screening.freshness()).toMatchObject({ snapshot: null, refresh: { failed: true } });
  });
  it('commits complete lists, screens listed/unlisted wallets and enforces persisted daily cadence across restarts', async () => {
    now += day;
    const download = vi.fn(async () => sdnFixture());
    const worker = new SanctionsWorker(db.chain, 'https://ofac.treasury.gov/fixture.xml', download, () => now);
    await Promise.all([worker.tick(), worker.tick()]);
    await new SanctionsWorker(db.chain, 'https://ofac.treasury.gov/fixture.xml', download, () => now).tick();
    expect(download).toHaveBeenCalledTimes(1);
    await expect(screening.assertWallet(unlisted)).resolves.toBeUndefined();
    await expect(screening.assertWallet(listedWallet.toUpperCase())).rejects.toMatchObject({ code: 'sanctioned', statusCode: 422, message: 'Trading is unavailable for this wallet.' });
    expect(await screening.freshness()).toMatchObject({ snapshot: { version: 1, address_count: 2 }, refresh: { failed: false } });
  });
  it('retains the complete list after network, partial, malformed and regressed refreshes', async () => {
    for (const failure of [async () => { throw new Error('private provider context'); }, async () => sdnFixture().slice(0, -12),
      async () => sdnFixture().replace('<Record_Count>2', '<Record_Count>3'), async () => sdnFixture(unlisted, '09/30/2026')]) {
      now += day;
      const observe = vi.fn();
      await new SanctionsWorker(db.chain, 'https://ofac.treasury.gov/fixture.xml', failure, () => now, observe).tick();
      expect(observe.mock.calls).toEqual([[true]]);
      expect(await screening.freshness()).toMatchObject({ snapshot: { version: 1 }, refresh: { failed: true } });
      await expect(screening.assertWallet(listedWallet)).rejects.toMatchObject({ code: 'sanctioned' });
    }
  });
  it('rolls back publication if the transaction fails after inserting the new snapshot', async () => {
    now += day;
    await db.chain.sql.query('ALTER TABLE ofac_refresh ADD CONSTRAINT fixture_failure CHECK(failed)');
    try {
      await new SanctionsWorker(db.chain, 'https://ofac.treasury.gov/fixture.xml', async () => sdnFixture(unlisted), () => now).tick();
      expect(await screening.freshness()).toMatchObject({ snapshot: { version: 1 }, refresh: { failed: true } });
      expect((await db.chain.sql.query('SELECT version FROM ofac_sdn')).rows).toHaveLength(1);
    } finally { await db.chain.sql.query('ALTER TABLE ofac_refresh DROP CONSTRAINT fixture_failure'); }
  });
  it('publishes a new version and never mixes address sets; retains the old version', async () => {
    now += day;
    await new SanctionsWorker(db.chain, 'https://ofac.treasury.gov/fixture.xml', async () => sdnFixture(unlisted, '10/02/2026'), () => now).tick();
    await expect(screening.assertWallet(unlisted)).rejects.toMatchObject({ code: 'sanctioned' });
    await expect(screening.assertWallet(listedWallet)).resolves.toBeUndefined();
    expect((await db.chain.sql.query('SELECT version FROM ofac_sdn')).rows).toHaveLength(2);
    expect(await screening.freshness()).toMatchObject({ snapshot: { version: 3 }, refresh: { failed: false } });
    const unavailable = new SanctionsService({ sql: { query: async () => { throw new Error('private database context'); } } } as never);
    await expect(unavailable.assertWallet(unlisted)).rejects.toMatchObject({ code: 'stale_data', message: 'Trading checks are unavailable. Try again later.' });
  });
});
