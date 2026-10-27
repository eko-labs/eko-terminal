import { readFileSync } from 'node:fs';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuardAssessmentV2Schema, TradeQuoteSchema, type TradeQuote, type TradeQuoteRequest, type TradeOrder } from '@eko/shared';
import { createTradeQuote } from '../../mocks/fixtures';
import { createRadarCard, createRadarRows } from '../../mocks/demo/radar';
import { createMockTransport } from '../../mocks/transport';
import { createApi } from '../../lib/api';
import { assessment } from '../../../../../packages/shared/test/fixtures/contracts/guard-v2';
import { REAL_FUNDS, DYOR, NON_AFFILIATION } from '../../copy';
import { TRADE_COPY as C } from '../../copy/trade';
import { FeeLines, TradePanelView } from './TradePanel';
import { TradeLock } from './TradeContext';
import { antiSnipeDeadline, emptyQuote, panelBlock, quoteExpired, tradeErrorText, tradeRequestKey, TradeQuoteSession, type PanelGate } from './tradePanelModel';
const css = readFileSync(new URL('./trade-panel.css', import.meta.url), 'utf8');
import coinSource from '../../pages/terminal/Coin.tsx?raw';
import radarSource from '../../pages/terminal/Radar.tsx?raw';
import pairsSource from '../../pages/terminal/Pairs.tsx?raw';
import inspectorSource from '../../pages/terminal/RadarParts.tsx?raw';

// Synthetic contracts only: no live route, wallet requests, acquisition or funds.
const now = 1_000_000;
const account = '0x00000000000000000000000000000000000000aa';
function quote(p: Partial<TradeQuote> = {}): TradeQuote {
  return TradeQuoteSchema.parse({ ...createTradeQuote(), id: 'fixture-quote', account, binding: true,
    amountUsd: 100, valueWei: '0', route: { venue: 'uniswap_v3', executable: true }, guard: { decision: 'allow', checks: [{ code: 'sell', status: 'pass', label: 'Sell simulation' }] },
    expiresAt: new Date(now + 15000).toISOString(), fee: { bps: 0, usd: 0, destination: null },
    amountIn: '900719925474099312345', expectedOut: '900719925474099312346', minOut: '900719925474099312344', ...p });
}
function gate(q = quote(), patch: Partial<PanelGate> = {}): PanelGate {
  const input: TradeQuoteRequest = { coin: q.coin, side: q.side, amountUsd: q.amountUsd, slippageBps: 50, riskMode: 'balanced', account };
  return { input, snapshot: { ...emptyQuote(), requestKey: tradeRequestKey(input), quote: q, requestedAt: now }, now, cap: 250, liveEnabled: true, stale: false,
    signerAvailable: true, wallet: { address: account, chainId: 4663 }, ...patch };
}
const actions = { changeSide: vi.fn(), changeAmount: vi.fn(), changeSlippage: vi.fn(), acknowledge: vi.fn(), submit: vi.fn(), retry: vi.fn() };
const html = (g: PanelGate, result?: string) => render(<TradePanelView gate={g} tier="reader" phase="launch_week" {...actions} result={result} />);
const warning = () => quote({ guard: { decision: 'warn', checks: [{ code: 'tax', label: 'Taxes', status: 'warn', value: 12 }, { code: 'exit', label: 'Exit cost', status: 'warn', value: 8 }] } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('shared guarded panel contract states', () => {
  it('renders allow with every quote quantity, cost, route and disclaimer before the action', () => {
    const g = gate(), text = html(g);
    expect(panelBlock(g)).toBeNull();
    for (const word of ['You pay', 'Input (raw units)', 'Native value (wei)', 'Expected received', 'Minimum received', 'Terminal fee', 'Buy tax', 'Sell tax', 'Exit cost at this size', 'Price impact', 'Network fee (execution + L1 data)', 'Uniswap v3', 'Quote block', 'reader', REAL_FUNDS, DYOR, NON_AFFILIATION]) expect(text).toContain(word);
    expect(text).toContain('900719925474099312345'); expect(text).not.toContain('≈');
    expect(text.indexOf('Terminal fee')).toBeLessThan(text.indexOf('tp-submit'));
    expect(text).toMatch(/class="btn tp-submit btn-primary">Buy/);
    expect(html(gate(quote({ side: 'sell' })))).toMatch(/class="btn tp-submit">Sell/);
    expect(text).toContain('<details>'); expect(text).toContain('1 check passed');
  });
  it('treats a binding quote that only lists an exact approval as actionable; the approval is the flow’s first step', () => {
    const q = quote({ side: 'sell', approvals: [{ token: account, spender: account, amount: '900719925474099312345', kind: 'erc20' }] });
    expect(panelBlock(gate(q))).toBeNull();
    // An approval shortfall reported as a hard refusal (the pre-fix server shape) stays refused, never offered.
    const refused = quote({ side: 'sell', binding: false, approvals: q.approvals, guard: { decision: 'refuse', checks: [{ code: 'token_approval_required', status: 'refuse', label: 'Refused' }] } });
    expect(panelBlock(gate(refused))).toBe(C.refused);
    expect(tradeErrorText('approval_required')).toContain('exact amount');
  });
  it('shows a scanning refusal as retryable, never as a Guard refusal', () => {
    const scanning = quote({ binding: false, guard: { decision: 'refuse', checks: [{ code: 'scanning', status: 'refuse', label: 'Still scanning' }] } });
    expect(panelBlock(gate(scanning))).toBe(tradeErrorText('scanning'));
    expect(tradeErrorText('scanning')).toMatch(/still scanning/i);
    const danger = quote({ binding: false, guard: { decision: 'refuse', checks: [{ code: 'scanning', status: 'refuse', label: 'Still scanning' }, { code: 'guard_danger', status: 'refuse', label: 'Danger' }] } });
    expect(panelBlock(gate(danger))).toBe(C.refused);
  });
  it.each([0, 50, 40, 30, 25] as const)('displays exactly %s bps from the quote, without an inferred tier fee or a fee destination', bps => {
    const q = quote({ fee: { bps, usd: bps / 100, destination: bps === 0 ? null : 'burn_wallet' } });
    const text = render(<FeeLines quote={q} tier="source" phase="launch_week" />);
    expect(text).toContain(`${bps / 100}% ($${bps / 100})`);
    // The fee line shows only the fee; it never says where fees go.
    expect(text).not.toMatch(/burn|→|destination/i); expect(text).not.toContain('null');
  });
  it('renders zero curve fee and never uses a quote-supplied external link', () => {
    const q = quote({ route: { venue: 'pons_curve', executable: false, linkOut: 'https://untrusted.example/trade' } });
    const text = html(gate(q)); expect(text).toContain('0% on Pons-curve trades'); expect(text).not.toContain('untrusted.example');
  });
  it('does not round a nonzero small network fee or coin price to zero', () => {
    const text = render(<TradePanelView gate={gate(quote({ networkFeeUsd: .000000123 }))} {...actions} priceUsd={.0032176} />);
    expect(text).toContain('$0.000000123'); expect(text).toContain('$0.00322');
  });
  const blocked: [string, () => PanelGate, string][] = [
    ['connect', () => { const g = gate(quote({ binding: false, account: undefined })); g.input.account = undefined; g.snapshot.requestKey = tradeRequestKey(g.input); return g; }, C.connect],
    ['indicative', () => gate(quote({ binding: false })), C.indicative],
    ['stale', () => gate(quote(), { stale: true }), C.stale],
    ['expired', () => gate(quote(), { now: now + 15000 }), C.expired],
    ['paused', () => gate(quote(), { liveEnabled: false }), C.paused],
    ['configuration missing', () => gate(quote(), { liveEnabled: undefined }), C.config],
    ['cap', () => gate(quote(), { cap: 1 }), C.cap(1)],
    ['refuse', () => gate(quote({ guard: { decision: 'refuse', checks: [{ code: 'sim', label: 'Sell simulation', status: 'refuse' }] } })), C.refused],
    ['refusing check with allow decision', () => gate(quote({ guard: { decision: 'allow', checks: [{ code: 'sim', label: 'Sell simulation', status: 'refuse' }] } })), C.refused],
    ['quote-only', () => gate(quote({ route: { venue: 'uniswap_v4', executable: false } })), C.quoteOnly],
    ['wrong network', () => gate(quote(), { wallet: { address: account, chainId: 1 } }), C.wrongNetwork],
    ['wallet mismatch', () => gate(quote(), { wallet: { address: '0x00000000000000000000000000000000000000bb', chainId: 4663 } }), C.wallet_mismatch],
    ['signer absent', () => gate(quote(), { signerAvailable: false }), C.signingUnavailable],
    ['zero fee destination mismatch', () => gate(quote({ fee: { bps: 0, usd: 0, destination: 'burn_wallet' } })), C.unavailable],
    ['non-launch fee destination mismatch', () => gate(quote({ fee: { bps: 50, usd: .5, destination: 'burn_engine' } })), C.unavailable],
    ['invalid amount', () => { const g = gate(); g.input.amountUsd = NaN; return g; }, C.invalid],
    ['invalid slippage', () => { const g = gate(); g.input.slippageBps = 10000; return g; }, C.invalid],
    ...(['not_allowlisted', 'trade_cap_exceeded', 'sanctioned', 'wallet_mismatch', 'stale_data', 'guard_refused', 'trading_paused', 'sim_unavailable'] as const).map(code => [code, () => { const g = gate(); g.snapshot.error = code; return g; }, code === 'stale_data' ? C.stale : code === 'guard_refused' ? C.refused : code === 'trading_paused' ? C.paused : code === 'sim_unavailable' ? C.unavailable : C[code]] as [string, () => PanelGate, string]),
  ];
  it.each(blocked)('%s has no actionable order path or warning override', async (_name, make, expected) => {
    const g = make(), text = html(g), execute = vi.fn();
    expect(panelBlock(g)).toBe(expected); expect(text).toContain(expected.replaceAll("'", "&#x27;"));
    expect(text).not.toMatch(/class="btn tp-submit(?: btn-primary)?">(?:Buy|Sell)/);
    expect(text).not.toContain(C.acknowledge);
    expect(await new TradeLock().run(g, execute)).toBeNull(); expect(execute).not.toHaveBeenCalled();
  });
  it('announces hard refusal assertively and keeps the fee lines visible', () => {
    const text = html(blocked.find(([name]) => name === 'refuse')![1]());
    expect(text).toContain('role="alert" aria-live="assertive"'); expect(text).toContain('Terminal fee');
  });
  it('keeps the runtime pause visible even when the configured launch cap is below the selected amount', () => {
    expect(panelBlock(gate(quote(), { liveEnabled: false, cap: 25 }))).toBe(C.paused);
  });
  it.each(['trading_paused', 'not_allowlisted', 'trade_cap_exceeded', 'sanctioned', 'wallet_mismatch'] as const)('renders 075 informational quote admission state %s', code => {
    const q = quote({ binding: false, guard: { decision: 'refuse', checks: [{ code, label: 'Current admission refused', status: 'refuse' }] } });
    const g = gate(q), execute = vi.fn();
    expect(panelBlock(g)).toBe(code === 'trading_paused' ? C.paused : C[code]);
    expect(html(g)).toContain('Terminal fee');
    void new TradeLock().run(g, execute); expect(execute).not.toHaveBeenCalled();
  });
  it('uses the existing versioned Guard renderer without promoting shadow assessments', () => {
    const text = render(<TradePanelView gate={gate()} {...actions} guard={GuardAssessmentV2Schema.parse(assessment)} />);
    expect(text).toContain('guard-compact'); expect(text).toContain('Shadow'); expect(text).toContain('Not fully checked');
  });
  it('captures a relative anti-snipe deadline once per snapshot, including source age', () => {
    const card = createRadarCard(createRadarRows()[0].address)!;
    expect(antiSnipeDeadline({ ...card, freshness: { block: 1, ageSec: 3 }, tradeability: { ...card.tradeability, antiSnipe: { taxPct: 12, endsInSec: 20 } } }, null, now)).toBe(now + 17000);
    expect(antiSnipeDeadline(null, null, now)).toBeUndefined();
  });
  it('disables presets above the configured cap and refuses custom amounts above it', () => {
    const text = html(gate(quote(), { cap: 50 }));
    for (const n of [100, 250]) expect(text).toMatch(new RegExp(`disabled=""[^>]*>${'\\$'}${n}</button>`));
    expect(panelBlock(gate(quote(), { cap: 50 }))).toBe(C.cap(50));
  });
  it('shows warnings with mode and measured values, then only accepts exact current codes', async () => {
    const g = gate(warning()), execute = vi.fn(async () => ({ status: 'submitted' }) as TradeOrder), lock = new TradeLock();
    expect(html(g)).toContain(C.acknowledge); expect(html(g)).toContain('Balanced treats'); expect(html(g)).toContain('warn · 12');
    expect(await lock.run(g, execute)).toBeNull();
    g.snapshot.acknowledged = ['tax']; expect(await lock.run(g, execute)).toBeNull();
    g.snapshot.acknowledged = ['tax', 'exit', 'unrelated'];
    await lock.run(g, execute); expect(execute).toHaveBeenCalledWith({ quote: g.snapshot.quote, input: g.input, acknowledged: ['tax', 'exit'], requestedAt: now });
    expect(html(g)).toContain('tp-submit btn-primary');
  });
  it.each(['slippageBps', 'riskMode', 'account', 'coin', 'side', 'amountUsd'] as const)('invalidates the displayed quote immediately on %s change', key => {
    const g = gate(); const input = { ...g.input, [key]: { slippageBps: 100, riskMode: 'safe', account: '0x00000000000000000000000000000000000000bb', coin: '0x00000000000000000000000000000000000000cc', side: 'sell', amountUsd: 25 }[key] } as TradeQuoteRequest;
    expect(panelBlock({ ...g, input })).not.toBeNull(); expect(html({ ...g, input })).not.toContain('Expected received');
  });
  it('enforces original age, backend expiry and invalid-clock boundaries', () => {
    const g = gate(); expect(quoteExpired(g.snapshot, now + 14999)).toBe(false); expect(quoteExpired(g.snapshot, now + 15000)).toBe(true);
    expect(quoteExpired(g.snapshot, now - 1)).toBe(true);
    expect(quoteExpired({ ...g.snapshot, quote: quote({ expiresAt: 'invalid' }) }, now)).toBe(true);
    expect(panelBlock(gate(quote({ expiresAt: new Date(now + 60000).toISOString() }), { now: now + 15000 }))).toBe(C.expired);
  });
  it('uses the one shared panel everywhere and requires expanding the phone sheet before any action', () => {
    for (const source of [coinSource, radarSource, pairsSource, inspectorSource]) { expect(source).toContain('<TradePanel'); expect(source).not.toContain('DisabledTradePanel'); }
    expect(coinSource).toContain('hidden={phone&&!sheet} inert={phone&&!sheet}'); expect(coinSource).toContain('visible={!phone||sheet}');
    expect(coinSource).toContain('new ResizeObserver(measure)'); expect(coinSource).toContain('--trade-sheet-clearance');
    expect(css).toContain('var(--trade-sheet-clearance, 140px)'); expect(css).toContain('env(safe-area-inset-bottom)'); expect(css).toContain('overflow-y:auto');
  });
  it('has labeled keyboard controls, visible focus, touch targets and no motion in either preference', () => {
    const text = html(gate()); expect(text).toContain('Custom trade amount'); expect(text).toContain('Slippage (%)'); expect(text).toContain('aria-pressed');
    expect(css).toContain(':focus-visible'); expect(css).toContain('outline:2px'); expect(css).toContain('@media(pointer:coarse)'); expect(css).toContain('min-height:44px');
    expect(css).toContain('animation:none;transition:none'); expect(text).not.toContain('autofocus');
  });
  it('keeps labels inert and renders actual order status without simulating fills', () => {
    const q = quote({ guard: { decision: 'refuse', checks: [{ code: 'sim', status: 'refuse', label: '<img src=x>\u202e' }] } });
    expect(html(gate(q))).toContain('&lt;img src=x&gt;'); expect(html(gate(q))).not.toContain('<img'); expect(html(gate(q))).not.toContain('\u202e');
    expect(html(gate(), C.statuses.submitted)).toContain('Submitted — waiting for confirmation.');
  });
});

describe('visible quote lifecycle with fixture backend', () => {
  it('renders request-scoped offline API fixtures while keeping execution and checks unavailable', async () => {
    const api = createApi('/v1', createMockTransport()), g = gate();
    for (const side of ['buy', 'sell'] as const) {
      const input = { ...g.input, side, amountUsd: 25 };
      const q = await api.parse('/trade/quote', TradeQuoteSchema, { body: input });
      expect(q).toMatchObject({ coin: input.coin, side, amountUsd: 25, account, binding: false, fee: { bps: 0, destination: null }, route: { executable: false }, approvals: [], guard: { decision: 'refuse' } });
      expect(Date.parse(q.expiresAt)).toBeGreaterThan(Date.now());
    }
    await expect(api.parse('/trade/quote', TradeQuoteSchema, { body: { ...g.input, amountUsd: 0 } })).rejects.toMatchObject({ status: 400 });
  });
  function setup(anti?: number, backend = vi.fn(async () => warning())) {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const g = gate(warning()), changed = vi.fn(), session = new TradeQuoteSession(g.input, backend, changed, Date.now, anti);
    return { session, backend, changed, g };
  }
  it('quotes on visibility, every five seconds, resets ack, and stops while hidden or disposed', async () => {
    const { session, backend } = setup(); session.setVisible(true); await vi.advanceTimersByTimeAsync(0);
    expect(backend).toHaveBeenCalledTimes(1); session.acknowledge(); expect(session.snapshot.acknowledged).toEqual(['tax', 'exit']);
    await vi.advanceTimersByTimeAsync(5000); expect(backend).toHaveBeenCalledTimes(2); expect(session.snapshot.acknowledged).toEqual([]);
    session.setVisible(false); await vi.advanceTimersByTimeAsync(20000); expect(backend).toHaveBeenCalledTimes(2);
    session.setVisible(true); await vi.advanceTimersByTimeAsync(0); expect(backend).toHaveBeenCalledTimes(3);
    session.dispose(); await vi.advanceTimersByTimeAsync(20000); expect(backend).toHaveBeenCalledTimes(3);
  });
  it('re-quotes exactly at anti-snipe decay and earlier backend quote expiry', async () => {
    const { session, backend } = setup(now + 1750, vi.fn(async () => warning()));
    session.setVisible(true); await vi.advanceTimersByTimeAsync(1749); expect(backend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(backend).toHaveBeenCalledTimes(2); session.dispose();
    const short = setup(undefined, vi.fn(async () => quote({ expiresAt: new Date(now + 1200).toISOString() })));
    short.session.setVisible(true); await vi.advanceTimersByTimeAsync(1200); expect(short.backend).toHaveBeenCalledTimes(2); short.session.dispose();
  });
  it('updates a moving tax deadline without restarting the quote session on every event', async () => {
    const {session,backend}=setup(now+4000); session.setVisible(true); await vi.advanceTimersByTimeAsync(0);
    for(let i=0;i<100;i++)session.setAntiSnipeEndsAt(now+4000+i);
    await vi.advanceTimersByTimeAsync(4098); expect(backend).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(backend).toHaveBeenCalledTimes(2); session.dispose();
  });
  it('does not spin on expired responses and cannot acknowledge them', async () => {
    const { session, backend } = setup(undefined, vi.fn(async () => warning()));
    vi.setSystemTime(now + 16000); session.setVisible(true); await vi.advanceTimersByTimeAsync(0);
    session.acknowledge(); expect(session.snapshot.acknowledged).toEqual([]); expect(backend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); expect(backend).toHaveBeenCalledTimes(2); session.dispose();
  });
  it('aborts and ignores out-of-order responses, including after disposal', async () => {
    const pending: ((q: TradeQuote) => void)[] = [], signals: AbortSignal[] = [];
    const backend = vi.fn((_input: TradeQuoteRequest, signal: AbortSignal) => { signals.push(signal); return new Promise<TradeQuote>(resolve => pending.push(resolve)); });
    vi.useFakeTimers(); vi.setSystemTime(now);
    const session = new TradeQuoteSession(gate().input, backend, vi.fn(), Date.now);
    session.setVisible(true); await session.refresh(); expect(backend).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);
    session.setVisible(false); expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); session.setVisible(true);
    pending[1](quote({ id: 'current' })); await vi.advanceTimersByTimeAsync(0);
    pending[0](quote({ id: 'old' })); await Promise.resolve();
    expect(session.snapshot.quote?.id).toBe('current');
    await vi.advanceTimersByTimeAsync(1000); const late = session.refresh(); session.dispose();
    pending[2](quote({ id: 'late' })); await late; expect(session.snapshot.quote?.id).toBe('current');
  });
  it('retains fee lines on refresh failure but disables ordering and drops ack', async () => {
    const { session, backend, g } = setup(); session.setVisible(true); await vi.advanceTimersByTimeAsync(0); session.acknowledge();
    backend.mockRejectedValueOnce({ code: 'not_allowlisted', message: '<untrusted provider detail>' });
    await vi.advanceTimersByTimeAsync(1000); await session.refresh(); expect(session.snapshot.quote).not.toBeNull(); expect(session.snapshot.acknowledged).toEqual([]);
    const view = html({ ...g, snapshot: session.snapshot }); expect(view).toContain('Terminal fee'); expect(view).toContain(C.not_allowlisted); expect(view).not.toContain('provider detail'); session.dispose();
  });
  it('rejects a backend quote for a different input and avoids invalid requests', async () => {
    const { session } = setup(undefined, vi.fn(async () => quote({ amountUsd: 999 })));
    session.setVisible(true); await vi.advanceTimersByTimeAsync(0); expect(session.snapshot.error).toBe('quote_changed'); session.dispose();
    const backend = vi.fn(), input = { ...gate().input, amountUsd: 0 }, invalid = new TradeQuoteSession(input, backend, vi.fn(), Date.now);
    invalid.setVisible(true); await vi.advanceTimersByTimeAsync(5000); expect(backend).not.toHaveBeenCalled(); invalid.dispose();
  });
  it('uses one lock for concurrent panel taps and releases it on failure', async () => {
    const lock = new TradeLock(), g = gate(); let finish!: () => void;
    const execute = vi.fn(() => new Promise<TradeOrder>(resolve => { finish = () => resolve({ status: 'submitted' } as TradeOrder); }));
    const first = lock.run(g, execute); expect(lock.busy).toBe(true); expect(await lock.run(g, execute)).toBeNull();
    finish(); await first; expect(lock.busy).toBe(false); expect(execute).toHaveBeenCalledTimes(1);
    await expect(lock.run(g, async () => { throw new Error('fixture'); })).rejects.toThrow('fixture'); expect(lock.busy).toBe(false);
  });
});
