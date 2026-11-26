import { describe, expect, it } from 'vitest';
import type { Bar, CoinCard, Flow, RadarRow, Verdict } from '@eko/shared';
import { coinWalk } from './Walkthrough';
import { STEER, ageShort, compact, changeChips, changeFromBars, countShort, filterTrades, flowBox, headerStats, holderStats, signedPct, stripFacts, totalSupply, tradeRows, usdShort } from './trader';

const card = (o: { supply?: Partial<CoinCard['supply']>; missing?: string[]; flags?: string[]; taxes?: [number, number]; stage?: string; curvePct?: number; sellable?: boolean } = {}) => ({
  identity: { stage: o.stage ?? 'graduated', curvePct: o.curvePct, deployer: '0xdddddddddddddddddddddddddddddddddddddddd' },
  tradeability: { honeypot: false, exitCostPct: { usd100: 3.6, usd1k: 4, usd10k: 9 }, buyTaxPct: o.taxes?.[0] ?? 0, sellTaxPct: o.taxes?.[1] ?? 0 },
  supply: { top10Pct: 34, devPct: 2.4, bundlesHeldPct: 0, exemptWalletsHeldPct: 0, freshWalletsPct: 12, burnedPct: 0, circulating: '1000000000', ...o.supply },
  meta: { tradeability: { confidence: 1, asOfBlock: 1, flags: o.sellable === false ? [] : ['sell_check_sellable'] }, supply: { confidence: 1, asOfBlock: 1, missing: o.missing ?? [], flags: o.flags ?? [] } },
}) as unknown as CoinCard;
const row = (o: Partial<RadarRow> = {}) => ({ priceUsd: 0.00002075, marketCapUsd: 20_750, liquidityUsd: 8_400, change1hPct: 12.4, change24hPct: -30.2, volume24hUsd: 51_300, ...o }) as RadarRow;
const verdict = (playbooks: { id: string; level: string }[] = [], evaluated: string[] = []) => ({ level: 'monitor', playbooks, evaluatedPlaybooks: evaluated }) as unknown as Verdict;
const fmt = (v: number) => `$${v}`;

describe('the trader strip', () => {
  it('shows the market cap big, then price, liquidity, volume, supply, curve and tax', () => {
    const { marketCap, stats } = headerStats(card({ stage: 'curve', curvePct: 67.456, taxes: [3, 3] }), row(), [], 0.00002075, fmt);
    expect(marketCap).toBe('$20.8K');
    expect(stats.map(s => [s.label, s.value])).toEqual([['Price', '$0.00002075'], ['Liq', '$8.4K'], ['24h Vol', '$51.3K'], ['Supply', '1B'], ['B. Curve', '67.46%'], ['Tax', '3% / 3%']]);
  });
  it('leaves out what it did not measure, and works out the market cap without a radar row', () => {
    const { marketCap, stats } = headerStats(card({ missing: [] }), null, [], 0.002, fmt);
    expect(marketCap).toBe('$2M');
    expect(stats.map(s => s.id)).toEqual(['price', 'supply', 'tax']);
    expect(headerStats(null, null, [], undefined, fmt)).toEqual({ marketCap: null, stats: [] });
    expect(totalSupply(null, row({ unavailable: ['marketCap'] }))).toBeNull();
  });
  it('takes 5m from the candles and 1h and 24h from the radar row', () => {
    const bars = [0, 60, 120, 180, 240, 300, 360].map((ts, i) => ({ ts, o: 1, h: 1, l: 1, c: [1, 1, 1.1, 1, 1, 1, 1.2][i]!, vUsd: 0 })) as Bar[];
    expect(changeFromBars(bars, 300)).toBeCloseTo(20);
    expect(changeFromBars(bars.slice(-1), 300)).toBeUndefined();
    // A gap far longer than the span is not "the last five minutes".
    expect(changeFromBars([{ ts: 0, o: 1, h: 1, l: 1, c: 1, vUsd: 0 }, { ts: 10_000, o: 2, h: 2, l: 2, c: 2, vUsd: 0 }], 300)).toBeUndefined();
    expect(changeChips(row(), bars).map(c => c.label)).toEqual(['5m', '1h', '24h']);
    expect(changeChips(row({ unavailable: ['change'] }), [])).toEqual([]);
  });
  it('writes numbers the way traders do', () => {
    expect([usdShort(0.4), usdShort(9.957), usdShort(44.6), usdShort(840), usdShort(20_750), usdShort(1_200_000), usdShort(-6_360)]).toEqual(['<$1', '$9.96', '$45', '$840', '$20.8K', '$1.2M', '−$6.36K']);
    expect([countShort(436), countShort(12_345), countShort(1e9), countShort(999_999_999), countShort(420e6), countShort(1_234)]).toEqual(['436', '12.3K', '1B', '1B', '420M', '1.23K']);
    expect([compact(999_999), compact(1_000), compact(12.345), compact(2.5e12)]).toEqual(['1M', '1K', '12.3', '2.5T']);
    expect([signedPct(12.44), signedPct(-3.1), signedPct(148.2), signedPct(0), signedPct(-0.01)]).toEqual(['+12.4%', '−3.1%', '+148%', '0.0%', '0.0%']);
    expect([ageShort(42), ageShort(300), ageShort(7200), ageShort(200_000)]).toEqual(['42s', '5m', '2h', '2d']);
  });
});

describe("EKO's strip and the holder stats", () => {
  it('steers in a word', () => {
    // A supporting line, never the answer's word again at headline size.
    for (const line of Object.values(STEER)) expect(line).toMatch(/^[A-Z].*\.$/);
    expect(Object.values(STEER).join(' ')).not.toMatch(/Looks OK|Be careful|Don't buy|Still checking/);
  });
  it('shows can you sell, $100 back, dev, top 10, snipers and bundles with gauges where they read', () => {
    const facts = stripFacts(card(), verdict([{ id: 'launch_snipers', level: 'monitor' }]));
    expect(facts.map(f => [f.label, f.value, f.tone])).toEqual([
      ['Can you sell?', 'Yes', 'good'], ['$100 gets back', '$96', 'good'], ['Dev holds', '2.4%', 'good'], ['Top 10', '34%', 'watch'], ['Snipers', 'Found', 'watch'], ['Bundles', '0%', 'good']]);
    expect(facts.find(f => f.id === 'top10')?.gauge).toBe(34);
  });
  it("fills in the owner's powers and the pool's lock, at most six facts", () => {
    const c = { ...card({ flags: ['history_partial'] }), control: { canMint: false, canPause: false, canBlacklist: false, canChangeTax: true, upgradeable: false }, liquidity: { lpStatus: 'removable' } } as unknown as CoinCard;
    expect(stripFacts(c, null).filter(f => f.id === 'powers' || f.id === 'lp').map(f => [f.label, f.value, f.tone])).toEqual([['Owner powers', 'Can tax', 'watch'], ['Pool money', 'Can be pulled', 'bad']]);
    const full = { ...card(), control: { canMint: true, canPause: false, canBlacklist: false, canChangeTax: false, upgradeable: false }, liquidity: { lpStatus: 'burned' } } as unknown as CoinCard;
    expect(stripFacts(full, verdict([{ id: 'launch_snipers', level: 'monitor' }]))).toHaveLength(6);
  });
  it('never calls the top 10 good news when a reason says a few wallets hold a lot', () => {
    expect(stripFacts(card({ supply: { top10Pct: 12 } }), null).find(f => f.id === 'top10')?.tone).toBe('good');
    expect(stripFacts(card({ supply: { top10Pct: 12 } }), null, true).find(f => f.id === 'top10')?.tone).toBe('watch');
    expect(holderStats(card({ supply: { top10Pct: 12 } }), null, true).find(f => f.id === 'top10')?.tone).toBe('watch');
  });
  it('leaves out what the card did not measure, never "not checked"', () => {
    const c = card({ missing: ['top10Pct', 'bundlesHeldPct'], flags: [] });
    expect(stripFacts(c, verdict()).map(f => f.id)).toEqual(['sell', 'back', 'dev']);
    expect(holderStats(card({ flags: ['history_partial'] }), null).map(f => f.id)).toEqual(['dev']);
    expect(stripFacts(null, null)).toEqual([]);
    expect(JSON.stringify(holderStats(card(), verdict([], ['launch_snipers'])))).not.toMatch(/not checked/i);
    expect(holderStats(card(), verdict([], ['launch_snipers'])).map(f => [f.label, f.value])).toEqual([
      ['Top 10', '34%'], ['Dev', '2.4%'], ['Bundlers', '0%'], ['Fresh wallets', '12%'], ['Insiders', '0%'], ['Snipers', 'None']]);
  });
});

describe('flow and trades', () => {
  const flows = [{ window: '1h', activity: { buyUsd: 28_000, sellUsd: 24_000, netUsd: 4_000, buys: 436, sells: 281, buyers: 120, sellers: 90, unattributed: 0 } },
    { window: '24h', activity: { buyUsd: 0, sellUsd: 0, netUsd: 0, buys: 0, sells: 0, buyers: 0, sellers: 0, unattributed: 0, recent: [
      { ts: 100, side: 'buy', usd: 50, tokens: 1_000_000, tx: '0xa', wallet: '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' },
      { ts: 90, side: 'sell', usd: 2_000, tokens: 50_000_000, tx: '0xb', wallet: '0x1111111111111111111111111111111111111111' },
      { ts: 90, side: 'sell', usd: 2_000, tokens: 50_000_000, tx: '0xb' }] } }] as unknown as Flow[];
  it('sums a window into the flow box, or says nothing for a window not measured', () => {
    expect(flowBox(flows, '1h')).toEqual({ vol: 52_000, buys: 436, buyUsd: 28_000, sells: 281, sellUsd: 24_000, net: 4_000, buyers: 120, sellers: 90 });
    expect(flowBox(flows, '5m')).toBeNull();
  });
  it('lists the latest trades with their market cap at the time, marks the dev, and keeps keys unique', () => {
    const rows = tradeRows(flows, 1e9, '0xdddddddddddddddddddddddddddddddddddddddd');
    expect(rows.map(r => [r.side, r.mc, r.dev])).toEqual([['buy', 50_000, true], ['sell', 40_000, false], ['sell', 40_000, false]]);
    expect(new Set(rows.map(r => r.key)).size).toBe(3);
    expect(tradeRows(flows, null, undefined)[0]!.mc).toBeNull();
    expect(filterTrades(rows, 'dev')).toHaveLength(1);
    expect(filterTrades(rows, 'big')).toHaveLength(2);
    expect(filterTrades(rows, 'sell')).toHaveLength(2);
    expect(filterTrades(rows, 'all')).toHaveLength(3);
  });
});

describe('the coin walkthrough on the trader layout', () => {
  it('lights the answer chip, the sell fact, and the trade button itself when there is one', () => {
    expect(coinWalk(false).map(s => s.id)).toEqual(['answer', 'sell', 'buy']);
    expect(coinWalk(false)[2]!.within).toEqual(['.tp-submit', '.tp-sides']);
    expect(coinWalk(true)[2]!.within).toBeUndefined();
  });
});
