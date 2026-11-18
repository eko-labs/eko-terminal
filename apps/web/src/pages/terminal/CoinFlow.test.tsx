import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Flow, FlowActivity } from '@eko/shared';
import { CoinFlowTab, CoinTrades, FlowWindows } from './CoinFlow';
import { FlowBar, flowFigure } from './FlowBar';

const NOW = 1_800_000_000, wallet = `0x${'ab'.repeat(20)}` as `0x${string}`, seller = `0x${'cd'.repeat(20)}` as `0x${string}`;
const labelsOff = { confidence: 1, asOfBlock: 1, unavailable: true, missing: ['agentPct', 'crewPct', 'humanPct', 'washEstPct'] };
const base = { agentPct: 0, crewPct: 0, humanPct: 0, washEstPct: 0, beta: true, confidence: 0, meta: labelsOff };
const busy: FlowActivity = { buyUsd: 3000, sellUsd: 1000, netUsd: 2000, buys: 6, sells: 2, buyers: 4, sellers: 1, unattributed: 1,
  largest: [{ wallet, side: 'buy', usd: 1800, trades: 3, lastTs: NOW - 90 }, { wallet: seller, side: 'sell', usd: 1000, trades: 2, lastTs: NOW - 30 }],
  recent: [{ ts: NOW - 30, side: 'sell', usd: 500, tokens: 1e6, tx: `0x${'11'.repeat(32)}`, wallet: seller }, { ts: NOW - 60, side: 'buy', usd: 20, tokens: 1e4, tx: `0x${'22'.repeat(32)}` }] };
const quiet: FlowActivity = { buyUsd: 0, sellUsd: 0, netUsd: 0, buys: 0, sells: 0, buyers: 0, sellers: 0, unattributed: 0, largest: [], recent: [] };
const flows = (a: FlowActivity): Flow[] => (['5m', '1h', '24h'] as const).map(window => ({ ...base, window, activity: a }));

describe('coin flow from measured trades', () => {
  it('shows buy vs sell instead of an unmeasured agent split', () => {
    const html = renderToStaticMarkup(<FlowBar flow={{ ...base, window: '1h', activity: busy }} unavailable legend />).replaceAll('<!-- -->', '');
    expect(html).toContain('Buys $3.0K (6), sells $1.0K (2) in the last hour');
    expect(html).toContain('4 wallets'); expect(html).toContain('+$2.0K');
    expect(html).not.toMatch(/agents|not checked yet|confidence/i);
    expect(flowFigure({ ...base, window: '1h', activity: busy }, true)).toBe('75% buys');
    expect(flowFigure({ ...base, window: '1h', activity: quiet }, true)).toBe('No trades');
    expect(flowFigure({ ...base, window: '1h' }, true)).toBeNull();
  });

  it('lists the hour\'s largest buyers and sellers, and says when wallets could not be matched', () => {
    const html = renderToStaticMarkup(<CoinFlowTab flows={flows(busy)} markers={[]} labelsUnavailable nowSec={NOW} />).replaceAll('<!-- -->', '');
    expect(html).toContain('Largest wallets in the last hour');
    expect(html).toContain('0xabab…abab'); expect(html).toContain('$1.8K'); expect(html).toContain('3 trades · 2m ago');
    expect(html).toContain('0xcdcd…cdcd'); expect(html).toContain('4 buyers · 1 seller');
    expect(html).toContain('1 trade in the hour could not be matched to a wallet');
    expect(html).toContain('not labelled yet'); expect(html).not.toContain('not checked yet');
  });

  it('shows a real empty state only when nothing traded', () => {
    const html = renderToStaticMarkup(<CoinFlowTab flows={flows(quiet)} markers={[]} labelsUnavailable nowSec={NOW} />);
    expect(html).toContain('No trades in the last hour.');
    expect(renderToStaticMarkup(<CoinTrades flows={flows(quiet)} markers={[]} labelsUnavailable />)).toContain('No trades in the last 24 hours.');
    // Still loading: a skeleton, not an empty state.
    expect(renderToStaticMarkup(<CoinFlowTab flows={[]} markers={[]} labelsUnavailable nowSec={NOW} />)).not.toContain('No trades');
  });

  it('lists the latest trades with their wallets', () => {
    const html = renderToStaticMarkup(<CoinTrades flows={flows(busy)} markers={[]} labelsUnavailable />).replaceAll('<!-- -->', '');
    expect(html).toContain('Latest trades'); expect(html).toContain('0xcdcd…cdcd'); expect(html).toContain('Not matched'); expect(html).toContain('$500');
  });

  it('names unmeasured flow once rather than in every window', () => {
    const html = renderToStaticMarkup(<FlowWindows flows={(['5m', '1h', '24h'] as const).map(window => ({ ...base, window }))} labelsUnavailable />);
    expect(html.match(/not checked yet/g)).toHaveLength(1);
  });
});
