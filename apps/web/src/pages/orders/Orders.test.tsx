import { renderToStaticMarkup as render } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TradeOrder } from '@eko/shared';
import { ApiError } from '../../lib/api';
import { CHAIN_KEY } from '../../lib/chain';
import { navGroups, breadcrumbTrail } from '../../components/shell/navigation';
import { resolveRoute } from '../../routes';
import { ORDERS_COPY } from '../../copy/orders';
import { SHELL_COPY } from '../../copy/shell';
import { explorerTxUrl, formatWei, hasOpenOrders, orderAmounts } from './ordersModel';
import { OrdersView } from './Orders';
import { watchOrders, type OrdersState } from './useOrders';

// Synthetic values only: no real wallet, coin or transaction.
const COIN = `0x${'ab'.repeat(20)}` as TradeOrder['coin'];
const TX = `0x${'cd'.repeat(32)}`;
const order = (patch: Partial<TradeOrder> = {}): TradeOrder => ({
  id: 'order-1', quoteId: 'quote-1', status: 'confirmed', coin: COIN, side: 'buy', feeBps: 0, txHash: TX,
  filledIn: '10000000000000000', filledOut: '1234567890000000000000000', createdAt: '2026-11-17T14:32:05.000Z', ...patch,
});
const untrusted = (text: string) => ({ text, flags: [], truncated: false });
const names = { [COIN.toLowerCase()]: { symbol: untrusted('DEMO'), name: untrusted('Demo coin') } };
const view = (state: OrdersState) => render(<OrdersView state={state} names={names} retry={() => {}} />);
afterEach(() => { vi.useRealTimers(); });

describe('wei formatting', () => {
  it.each([
    ['0', '0'],
    ['1000000000000000000', '1'],
    ['10000000000000000', '0.01'],
    ['1500000000000000000', '1.5'],
    ['123456789000000000', '0.1235'],
    ['12345000000000', '0.00001235'],
    ['1', '0.000000000000000001'],
    ['999999960000000000000', '1,000'],
    ['1234567890000000000000000', '1,234,567.89'],
    ['1000000000000000000000000000', '1,000,000,000'],
  ])('formats %s wei as %s', (wei, text) => expect(formatWei(wei)).toBe(text));
  it('formats other decimals and rejects non-integers', () => {
    expect(formatWei('1234500', 6)).toBe('1.2345');
    expect(formatWei(5n * 10n ** 17n)).toBe('0.5');
    for (const bad of ['', '1.5', '0x10', 'abc', undefined, null]) expect(formatWei(bad)).toBe('—');
  });
  it('reads a buy as native paid for coins, and a sell as coins paid for native', () => {
    expect(orderAmounts(order())).toEqual({ native: { wei: '10000000000000000', text: '0.01', dir: 'paid' }, coin: { wei: '1234567890000000000000000', text: '1,234,567.89', dir: 'received' } });
    const sell = orderAmounts(order({ side: 'sell', filledIn: '2000000000000000000000', filledOut: '30000000000000000' }));
    expect(sell.native).toMatchObject({ text: '0.03', dir: 'received' }); expect(sell.coin).toMatchObject({ text: '2,000', dir: 'paid' });
    expect(orderAmounts(order({ status: 'submitted', filledIn: undefined, filledOut: undefined }))).toMatchObject({ native: { text: null }, coin: { text: null } });
  });
  it("links transactions to this build's explorer and drops malformed hashes", () => {
    const base = CHAIN_KEY === 'robinhood' ? 'https://robinhoodchain.blockscout.com' : 'https://elysium.kinetiq.xyz/explorer';
    expect(explorerTxUrl(TX)).toBe(`${base}/tx/${TX}`);
    for (const bad of [undefined, '', '0x1234', `${TX}00`, `javascript:${TX}`]) expect(explorerTxUrl(bad)).toBeNull();
  });
});

describe('Orders page states', () => {
  it('signed out: the shell sign-in prompt, and no list', () => {
    const html = view({ kind: 'signed_out' });
    expect(html).toContain(SHELL_COPY.connect); expect(html).toContain(`>${SHELL_COPY.wallet}</button>`);
    expect(html).not.toContain('<table'); expect(html).toContain(`<h1>${ORDERS_COPY.title}</h1>`);
  });
  it('loading: a busy skeleton with a status for screen readers', () => {
    const html = view({ kind: 'loading' });
    expect(html).toContain('aria-busy="true"'); expect(html).toContain('class="skel"'); expect(html).toContain(ORDERS_COPY.loading);
  });
  it('error: an alert with Retry', () => {
    const html = view({ kind: 'error', message: 'boom' });
    expect(html).toMatch(/role="alert"[^>]*>.*Could not load your orders\..*>Retry<\/button>/);
  });
  it('empty: the empty state with a way to Radar', () => {
    const html = view({ kind: 'ready', rows: [], refreshing: false });
    expect(html).toContain('class="empty panel ord-empty"'); expect(html).toContain(ORDERS_COPY.emptyTitle); expect(html).toContain('href="/radar"');
    expect(html).not.toContain('<table');
  });
  it('list: coin, side, readable amounts, status, time and the explorer link, as a table and as cards', () => {
    const html = view({ kind: 'ready', rows: [order()], refreshing: false });
    expect(html).toContain(`href="/coin/${COIN}"`); expect(html).toContain('DEMO'); expect(html).toContain('Demo coin');
    expect(html).toContain('>Buy<'); expect(html).toContain('>Filled<');
    expect(html).toContain('<span class="num">0.01</span> <span class="ord-dir">paid</span>');
    expect(html).toContain('<span class="num">1,234,567.89</span> <span class="ord-dir">received</span>');
    expect(html).not.toMatch(/10000000000000000|1234567890000000000000000/);
    expect(html).toContain(`href="${explorerTxUrl(TX)}"`); expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('dateTime="2026-11-17T14:32:05.000Z"');
    expect(html).toContain(`<th scope="col" class="r">${CHAIN_KEY === 'robinhood' ? 'ETH' : 'HYPE'}</th>`);
    expect(html).toContain('<table'); expect(html).toContain('class="ord-cards"');
    expect(html).not.toContain('role="status" class="ord-live"');
  });
  it('names the chain’s native coin in copy', () => {
    expect(ORDERS_COPY.native).toBe(CHAIN_KEY === 'robinhood' ? 'ETH' : 'HYPE');
    expect(ORDERS_COPY.intro).toContain(ORDERS_COPY.native);
  });
  it('shows a pending notice, failure reasons and unnamed coins safely', () => {
    const rows = [order({ id: 'a', status: 'submitted', filledIn: undefined, filledOut: undefined }), order({ id: 'b', status: 'failed', errorCode: 'reverted', side: 'sell' }), order({ id: 'c', coin: `0x${'12'.repeat(20)}` as TradeOrder['coin'], txHash: undefined })];
    const html = render(<OrdersView state={{ kind: 'ready', rows, refreshing: false }} names={{ [COIN.toLowerCase()]: { symbol: untrusted('<img src=x>'), name: untrusted('Demo') } }} retry={() => {}} />);
    expect(html).toContain(ORDERS_COPY.pending(1)); expect(html).toContain('ord-open');
    expect(html).toContain('Reverted on chain'); expect(html).toContain('>Sell<');
    expect(html).toContain('0x1212…1212'); expect(html).toContain(ORDERS_COPY.unnamed);
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
  });
});

describe('refresh while orders are submitted', () => {
  const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  it('loads again while any order is submitted, then stops once all settle', async () => {
    vi.useFakeTimers();
    const replies = [[order({ status: 'submitted' })], [order({ status: 'submitted' })], [order()]];
    const load = vi.fn(async () => ({ rows: replies.shift() ?? [order()] })), states: OrdersState[] = [];
    const w = watchOrders(load, s => states.push(s), 5000);
    await tick(); expect(load).toHaveBeenCalledTimes(1); expect(states.at(-1)).toMatchObject({ kind: 'ready', refreshing: false });
    expect(hasOpenOrders((states.at(-1) as { rows: TradeOrder[] }).rows)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); expect(load).toHaveBeenCalledTimes(2);
    // A refresh keeps the list on screen.
    expect(states).toContainEqual(expect.objectContaining({ kind: 'ready', refreshing: true }));
    await vi.advanceTimersByTimeAsync(5000); expect(load).toHaveBeenCalledTimes(3);
    expect(states.at(-1)).toMatchObject({ kind: 'ready', rows: [{ status: 'confirmed' }] });
    await vi.advanceTimersByTimeAsync(60_000); expect(load).toHaveBeenCalledTimes(3);
    w.stop();
  });
  it('stops on unmount, and reads 401 as signed out', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => ({ rows: [order({ status: 'submitted' })] }));
    const w = watchOrders(load, () => {}, 5000); await tick(); w.stop();
    await vi.advanceTimersByTimeAsync(20_000); expect(load).toHaveBeenCalledTimes(1);
    const states: OrdersState[] = [];
    watchOrders(async () => { throw new ApiError(401, 'wallet_auth_required', 'Sign in'); }, s => states.push(s)); await tick();
    expect(states.at(-1)).toEqual({ kind: 'signed_out' });
  });
});

describe('Orders navigation', () => {
  it('lists Orders under Terminal, right after Bags', () => {
    const terminal = navGroups().find(([group]) => group === 'Terminal')![1].map(([to, label]) => [to, label]);
    const bags = terminal.findIndex(([to]) => to === '/bags');
    expect(terminal[bags + 1]).toEqual(['/orders', 'Orders']);
  });
  it('registers /orders as a launch route with its page', async () => {
    const route = resolveRoute('/orders')!.route;
    expect(route).toMatchObject({ path: '/orders', stage: 'T', workspace: 'terminal', title: 'Orders' });
    expect(typeof (await route.load()).default).toBe('function');
    expect(breadcrumbTrail('/orders')).toEqual(['Terminal', 'Orders']);
  });
});
