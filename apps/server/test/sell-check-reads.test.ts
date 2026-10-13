import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { binary } from '@eko/db';
import { persistSellCheck, recordSellRefusal, type SellCheckResult } from '@eko/engines';
import { CoinCardSchema, PairRowSchema, RadarResponseSchema, type CoinCard } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedReadFixture, sampleAddress } from './read-fixture.js';

// Indexer fixture plus synthetic sell-check rows: no RPC, no live chain data.
let built: Awaited<ReturnType<typeof buildApp>>, card: CoinCard;
const now = Date.now();
beforeAll(async () => {
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'test-only-placeholder'.repeat(2), LEGACY_API: 'false', RUN_WORKER: 'false', MARKET_DATA_SOURCE: 'onchain' }), { startBackground: false });
  built.ctx.reads.store.now = () => now;
  card = await seedReadFixture(built.ctx.dbh.chain, now);
});
afterAll(async () => { await built.close(); });
const coin = () => card.identity.address;
const check = (status: SellCheckResult['status'], exit100: number | null, exit1k: number | null): SellCheckResult => ({
  coin: coin(), block: card.verdict.asOfBlock, status, route: { venue: 'pons_curve', coin: coin(), curve: sampleAddress(77) }, ethUsd: 2000, probes: [], requests: 2, exit100, exit1k });
const radarRow = async () => {
  await built.ctx.reads.store.currentModels();await built.ctx.reads.radar.refreshTotals();
  const body = RadarResponseSchema.parse((await built.app.inject('/v1/radar')).json());
  return { row: body.rows.find(r => r.address === coin())!, totals: body.totals! };
};
const pairRow = async () => z.object({ rows: z.array(PairRowSchema) }).parse((await built.app.inject('/v1/pairs?stage=new')).json()).rows.find(r => r.address === coin());
const coinCard = async () => CoinCardSchema.parse((await built.app.inject(`/v1/coins/${coin()}`)).json());

describe('sell-check readings in the read model', () => {
  it('reads a Pons coin whose curve address is not indexed yet as on its curve, not graduated', async () => {
    const db = built.ctx.dbh.chain, fresh = sampleAddress(4242);
    await db.sql.query(`INSERT INTO tokens(address,first_block,block,name,symbol,launchpad) VALUES($1,$2,$2,'Fresh launch','FRESH','pons')`, [binary(fresh), card.verdict.asOfBlock]);
    const [entry] = await built.ctx.reads.store.rows(fresh);
    expect(entry.row.stage).toBe('curve');
    await db.sql.query('DELETE FROM tokens WHERE address=$1', [binary(fresh)]);
  });
  it('sends the New pairs header counts with the first New page only', async () => {
    const first = (await built.app.inject('/v1/pairs?stage=new')).json() as { today?: { launches: number; medianFirstScanSec: number | null; refused: number } };
    expect(first.today).toBeDefined();
    expect(Number.isInteger(first.today!.launches)).toBe(true); expect(first.today!.launches).toBeGreaterThanOrEqual(0);
    expect(first.today!.refused).toBeGreaterThanOrEqual(0); expect(first.today!.refused).toBeLessThanOrEqual(first.today!.launches);
    expect(first.today!.medianFirstScanSec === null || first.today!.medianFirstScanSec >= 0).toBe(true);
    expect(((await built.app.inject('/v1/pairs?stage=migrated')).json() as { today?: unknown }).today).toBeUndefined();
  });
  it('keeps exit cost unavailable and the refusal stat absent until something is measured', async () => {
    const { row, totals } = await radarRow();
    expect(row.unavailable).toContain('exitCost');
    expect(row.sellCheck).toBeUndefined();
    expect(totals.honeypotsRefused).toBeUndefined();
    expect(totals.refusedByHour).toBeUndefined();
    expect((await coinCard()).meta?.tradeability?.unavailable).toBe(true);
    expect((await pairRow())?.unavailable).toContain('exitCost');
  });
  it('fills exit cost at $1K and $100 and the sellable status from a measured reading, naming what it did not measure', async () => {
    await persistSellCheck(built.ctx.dbh.chain, check('sellable', 6.5, 8.25), new Date(now - 60_000), new Date(now - 120_000));
    const { row } = await radarRow();
    expect(row.unavailable).not.toContain('exitCost');
    expect(row.exitCost1kPct).toBe(8.25);
    expect(row.sellCheck).toEqual({ status: 'sellable', asOfBlock: card.verdict.asOfBlock, checkedAt: new Date(now - 60_000).toISOString() });
    expect(await pairRow()).toMatchObject({ exitCost100Pct: 6.5 });
    expect((await pairRow())?.unavailable).not.toContain('exitCost');
    const projected = await coinCard();
    expect(projected.tradeability.exitCostPct).toEqual({ usd100: 6.5, usd1k: 8.25, usd10k: 0 });
    expect(projected.tradeability.honeypot).toBe(false);
    expect(projected.meta?.tradeability).toMatchObject({ unavailable: false, asOfBlock: card.verdict.asOfBlock, flags: expect.arrayContaining(['sell_check_sellable']) });
    expect(projected.meta?.tradeability?.missing).toEqual(expect.arrayContaining(['exitCostPct.usd10k', 'buyTax', 'sellTax', 'taxes', 'antiSnipeTiming']));
    expect(projected.meta?.tradeability?.missing).not.toContain('simulations');
    // The verdict and the engine card are untouched: the reading is a read-time overlay.
    expect((await built.ctx.dbh.chain.sql.query<{ data: CoinCard }>('SELECT data FROM coin_card_latest WHERE coin=$1', [binary(coin())])).rows[0]!.data.meta?.tradeability?.unavailable).toBe(true);
  });
  it('shows a failed sell as refused, and an unmeasured size as unavailable', async () => {
    await persistSellCheck(built.ctx.dbh.chain, check('refused', 100, null), new Date(now - 30_000), new Date(now - 120_000));
    const { row } = await radarRow();
    expect(row.sellCheck?.status).toBe('refused');
    expect(row.unavailable).toContain('exitCost');
    expect(await pairRow()).toMatchObject({ exitCost100Pct: 100 });
    const projected = await coinCard();
    expect(projected.meta?.tradeability?.missing).toContain('exitCostPct.usd1k');
    expect(projected.meta?.tradeability?.flags).toContain('sell_check_refused');
  });
  it('drops readings older than two days back to not checked yet', async () => {
    built.ctx.reads.store.now = () => now + 49 * 3600_000;
    try {
      expect((await coinCard()).meta?.tradeability?.unavailable).toBe(true);
    } finally { built.ctx.reads.store.now = () => now; }
  });
  it('counts refused buy quotes per coin in the Radar totals only while quotes run the sell check', async () => {
    await recordSellRefusal(built.ctx.dbh.chain, check('refused', 100, 100), new Date(now - 1000), 250);
    await recordSellRefusal(built.ctx.dbh.chain, check('refused', 100, 100), new Date(now - 500), 50);
    expect((await radarRow()).totals.honeypotsRefused).toBeUndefined();
    built.ctx.reads.store.sellCheckQuotes = true;
    try {
      const { totals } = await radarRow();
      expect(totals.honeypotsRefused).toBe(1);
      expect(totals.refusedByHour?.reduce((a, b) => a + b, 0)).toBe(1);
      expect(totals.refusedByHour?.[23]).toBe(1);
    } finally { built.ctx.reads.store.sellCheckQuotes = false; }
  });
});
