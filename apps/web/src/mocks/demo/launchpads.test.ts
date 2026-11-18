import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarSchema, CoinCardSchema, RadarRowSchema, TradeQuoteSchema } from '@eko/shared';
import { createRadarCard, createRadarRows } from './radar';
import { createPairRows } from './pairs';
import { coinCandles } from './coin';
import { isQuotedDemoCoin, moreLaunchpadsOn, quotedRows } from './launchpads';
import { createApi } from '../../lib/api';
import { createMockTransport } from '../transport';
import { quoteLabel, quotedIn } from '../../copy/chain';
import { tradeErrorText } from '../../components/trade/tradePanelModel';
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
      expect(row.unavailable).toContain('exitCost');
      const card = createRadarCard(row.address)!;
      expect(CoinCardSchema.parse(card)).toEqual(card);
      expect(card.identity.pools[0]).toMatchObject({ venue: 'uniswap_v4', executable: false });
      expect(card.playbooks.some(m => m.id === 'malicious_hook')).toBe(true);
      expect(card.meta?.tradeability?.missing).toContain('exitCostPct');
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
    for (const row of quotedRows()) { walk(row); walk(createRadarCard(row.address)); }
    expect(strings.filter(v => /mock|demo|example|sample|test|fake|fixture/i.test(v))).toEqual([]);
    const hex = strings.filter(v => /^0x[0-9a-f]{40}([0-9a-f]{24})?$/.test(v));
    expect(hex.length).toBeGreaterThan(0);
    // No long runs of one digit or a repeated pair (0x0000…, 0xabab…).
    expect(hex.filter(v => /(.)\1{5}|(..)\2{3}/.test(v.slice(2)))).toEqual([]);
  });

  it('puts them on New pairs', () => {
    vi.stubEnv('VITE_FLAGS', 'more_launchpads');
    const pairs = createPairRows().filter(r => r.quoteSymbol);
    expect(pairs.map(r => [r.symbol.text, r.column])).toEqual([['QMNT', 'new'], ['KITE', 'new'], ['HRBR', 'new']]);
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
