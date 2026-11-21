import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarSchema, CoinCardSchema, FlowSchema, RadarRowSchema, TradeQuoteSchema } from '@eko/shared';
import { createRadarCard, createRadarRows } from './radar';
import { createPairRows } from './pairs';
import { coinCandles, coinResponse } from './coin';
import { advancePairs } from './market';
import { isQuotedDemoCoin, moreLaunchpadsOn, quotedRows } from './launchpads';
import { createApi } from '../../lib/api';
import { createMockTransport } from '../transport';
import { quoteLabel, quotedIn } from '../../copy/chain';
import { tradeErrorText } from '../../components/trade/tradePanelModel';
import { sellCheckNotAvailable } from '../../lib/sellCheck';
import { TRADE_COPY } from '../../copy/trade';

afterEach(() => { vi.unstubAllEnvs(); });

describe('Every launchpad demo (flag more_launchpads)', () => {
  it('stays out of the demo unless the flag is on', () => {
    vi.stubEnv('VITE_FLAGS', '');
    expect(moreLaunchpadsOn()).toBe(false);
    expect(quotedRows()).toEqual([]);
    expect(createRadarRows()).toHaveLength(30);
    expect(moreLaunchpadsOn('d0,more_launchpads')).toBe(true);
  });

  it('adds long.xyz coins quoted in a stock token, WETH and USDG to the radar, with coin pages and checks', () => {
    vi.stubEnv('VITE_FLAGS', 'more_launchpads');
    const rows = createRadarRows(), quoted = rows.filter(r => r.quoteSymbol);
    expect(rows).toHaveLength(33);
    expect(new Set(rows.map(r => r.address)).size).toBe(33);
    expect(quoted.map(r => r.quoteSymbol)).toEqual(['TTWO', 'WETH', 'USDG']);
    const labels: string[] = [];
    for (const row of quoted) {
      expect(RadarRowSchema.parse(row)).toEqual(row);
      expect(row.launchpad).toBe('longxyz');
      // As live: the sell check runs in the pool's own quote, except where EKO has no balance reading for it (WETH).
      const weth = row.quoteSymbol === 'WETH';
      if (weth) expect(row.unavailable).toContain('exitCost'); else expect(row.unavailable).not.toContain('exitCost');
      const card = createRadarCard(row.address)!;
      expect(CoinCardSchema.parse(card)).toEqual(card);
      expect(card.identity.pools[0]).toMatchObject({ venue: 'uniswap_v4', executable: false });
      // Only the pool on the fee module EKO has not reviewed keeps the hook finding.
      expect(card.playbooks.some(m => m.id === 'malicious_hook')).toBe(row.quoteSymbol === 'USDG');
      expect(card.meta?.tradeability?.missing).toContain(weth ? 'exitCostPct' : 'exitCostPct.usd100');
      labels.push(quoteLabel(card.identity.quoteAsset, card.identity.quoteSymbol));
      const bars = coinCandles(row.address, '5m');
      expect(bars).toHaveLength(72);
      for (const bar of bars) { expect(BarSchema.parse(bar)).toEqual(bar); expect(bar.h).toBeGreaterThanOrEqual(Math.max(bar.o, bar.c)); expect(bar.l).toBeLessThanOrEqual(Math.min(bar.o, bar.c)); }
    }
    expect(labels).toEqual(['Stock token · TTWO', 'WETH', 'USDG']);
    // The concentrated coin is the one Danger.
    expect(quoted.find(r => r.quoteSymbol === 'WETH')).toMatchObject({ verdict: 'danger', topPlaybook: 'holder_concentration' });
  });

  it('reads as real data on film: no placeholder words, no patterned addresses', () => {
    vi.stubEnv('VITE_FLAGS', 'more_launchpads');
    const strings: string[] = [];
    const walk = (v: unknown) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    for (const row of quotedRows()) { walk(row); walk(createRadarCard(row.address)); for (const w of ['5m', '1h', '24h']) walk(coinResponse(row.address, 'flow', new URLSearchParams({ window: w }))); }
    expect(strings.filter(v => /mock|demo|example|sample|test|fake|fixture/i.test(v))).toEqual([]);
    const hex = strings.filter(v => /^0x[0-9a-f]{40}([0-9a-f]{24})?$/.test(v));
    expect(hex.length).toBeGreaterThan(0);
    // No long runs of one digit or a repeated pair (0x0000…, 0xabab…).
    expect(hex.filter(v => /(.)\1{5}|(..)\2{3}/.test(v.slice(2)))).toEqual([]);
  });

  it('puts them on New pairs', () => {
    vi.stubEnv('VITE_FLAGS', 'more_launchpads');
    const pairs = createPairRows().filter(r => r.quoteSymbol);
    expect(pairs.map(r => [r.symbol.text, r.column])).toEqual([['QMNT', 'new'], ['COPR', 'new'], ['HRBR', 'new']]);
    // The holder check's figures, as the edge's pairRow adds them; the grade stays (no sell check will come to change it).
    const hrbr = pairs.find(r => r.symbol.text === 'HRBR')!;
    expect(hrbr).toMatchObject({ verdict: 'monitor', verdictPending: false, top10Pct: 27, devPct: 0, earlyHeldPct: 8.1 });
    expect(hrbr.buyers).toBeGreaterThan(10);
    // No symbol shared with another coin on the page.
    const symbols = createPairRows().map(r => r.symbol.text);
    for (const r of pairs) expect(symbols.filter(x => x === r.symbol.text)).toHaveLength(1);
    const after = advancePairs();
    expect(after.filter(r => r.quoteSymbol)).toEqual([]);
  });

  it('shows what production measures and leaves unchecked only what it does not run', async () => {
    vi.stubEnv('VITE_FLAGS', 'more_launchpads');
    const rows = quotedRows();
    // Graded from the checks that ran (assess.ts judge), never Pending or Scanning while something was found.
    expect(rows.map(r => [r.symbol.text, r.verdict, r.verdictPending, r.topPlaybook])).toEqual([
      ['HRBR', 'monitor', false, 'holder_concentration'], ['COPR', 'danger', false, 'holder_concentration'], ['QMNT', 'monitor', false, 'malicious_hook']]);
    expect(rows.map(r => [r.exitCost1kPct, r.sellCheck?.status])).toEqual([[2.99, 'sellable'], [0, undefined], [3.98, 'sellable']]);
    for (const row of rows) {
      const card = createRadarCard(row.address)!, weth = row.quoteSymbol === 'WETH';
      expect(card.verdict.evaluatedPlaybooks).toEqual(weth ? ['agent_bait', 'malicious_hook', 'fee_trap_pool', 'removable_liquidity'] : undefined);
      expect(sellCheckNotAvailable(card)).toBe(weth);
      expect(card.verdict.reasons).toHaveLength(card.playbooks.length);
      // Measured: flow per window, volume, holders. Not run, as on the edge: sell check, depth and LP status, owner powers, fresh wallets, labels.
      expect(row.volume24hUsd).toBeGreaterThan(0);
      expect(row.trades24h).toBeGreaterThan(0);
      expect(card.meta?.tradeability).toMatchObject(weth ? { unavailable: true, missing: ['exitCostPct'] } : { confidence: 1, missing: ['exitCostPct.usd100', 'exitCostPct.usd10k'], flags: ['probe_usd_1000'] });
      expect(card.meta?.liquidity).toMatchObject({ missing: ['depthUsd', 'lpStatus'] });
      expect(card.meta?.liquidity?.unavailable).toBeUndefined();
      expect(card.meta?.control?.unavailable).toBe(true);
      expect(card.meta?.supply).toMatchObject({ confidence: 1, missing: ['freshWalletsPct', 'exemptWalletsHeldPct'] });
      expect(card.meta?.flow).toMatchObject({ unavailable: true, flags: ['activity_measured', 'wallet_labels_unavailable'] });
      const flows = await Promise.all((['5m', '1h', '24h'] as const).map(w => coinResponse(row.address, 'flow', new URLSearchParams({ window: w }))));
      for (const flow of flows) expect(FlowSchema.parse(flow).activity).toBeDefined();
      const [, hour, day] = flows.map(f => FlowSchema.parse(f));
      // The pool's liquidity is what was paid in on net since launch, and the hour's activity is the card's.
      expect(day!.activity!.netUsd).toBeCloseTo(row.liquidityUsd, 0);
      expect(day!.activity!.buys + day!.activity!.sells).toBe(row.trades24h);
      expect({ ...hour!.activity, largest: undefined, recent: undefined }).toEqual({ ...card.flow.activity, largest: undefined, recent: undefined });
      expect(hour!.activity!.largest!.length).toBeGreaterThan(0);
      expect(day!.activity!.recent!.length).toBe(Math.min(50, row.trades24h!));
    }
    // HRBR's snipers are its first buyers, in the launch second.
    const hrbr = createRadarCard(rows[0]!.address)!, snipers = hrbr.playbooks.find(m => m.id === 'launch_snipers')!;
    expect(hrbr.verdict.reasons).toContain('3 wallets bought 14.2% of supply within 3.5 seconds of launch; they still hold 11.6%.');
    expect(snipers.evidence.filter(e => e.label === 'Launch sniper')).toHaveLength(3);
  });

  it('answers a trade quote with the not-traded refusal, and the panel says so', async () => {
    vi.stubEnv('VITE_FLAGS', 'more_launchpads');
    const api = createApi('/v1', createMockTransport()), coin = quotedRows()[0]!.address;
    expect(isQuotedDemoCoin(coin)).toBe(true);
    const request = { coin, side: 'buy', amountUsd: 25, slippageBps: 100 };
    await expect(api.parse('/trade/quote', TradeQuoteSchema, { method: 'POST', body: request })).rejects.toMatchObject({ status: 409, code: 'not_traded' });
    expect(tradeErrorText('not_traded')).toBe(TRADE_COPY.notTraded);
    // A coin from the 30 profiles still gets the demo quote.
    const other = createRadarRows()[0]!.address;
    expect((await api.parse('/trade/quote', TradeQuoteSchema, { method: 'POST', body: { ...request, coin: other } })).coin).toBe(other);
  });
});

describe('quote labels', () => {
  it('names the stock, WETH and USDG, and the native coin plainly', () => {
    expect(quoteLabel('stock_token', 'TTWO')).toBe('Stock token · TTWO');
    expect(quoteLabel('stock_token')).toBe('Stock token');
    expect(quoteLabel('ETH', 'WETH')).toBe('WETH');
    expect(quoteLabel('USDG', 'USDG')).toBe('USDG');
    expect(quoteLabel('ETH')).toBe('ETH');
    expect(quoteLabel('other')).toBe('Other token');
    expect(quotedIn('TTWO')).toBe('in TTWO');
    expect(quotedIn(undefined)).toBeNull();
  });
});
