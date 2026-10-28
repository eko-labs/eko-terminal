import { describe, expect, it } from 'vitest';
import { GAS_RESERVE_ETH, NETWORKS, routeFor, sellQuantity, type Order, type Quote } from '@eko/shared';
import { ApiError } from './api';
import { SUBMITTED_MESSAGE, failureFrom, fillMessage, runLive, type InstantPhase, type InstantRequest, type LiveEnv } from './instantFlow';

const MAINNET = NETWORKS['robinhood-mainnet'];
const ETH_ROUTE = routeFor('robinhood-mainnet', 'ETH-USD')!;
const WALLET = '0x00000000000000000000000000000000000000aa';

function order(p: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    mode: 'live',
    market: 'ETH-USD',
    side: 'buy',
    signalId: null,
    botId: null,
    network: 'robinhood-mainnet',
    venue: 'uniswap-v3',
    assetIn: 'USDG',
    assetOut: 'ETH',
    amountIn: 100,
    expectedOut: 0.0376,
    minOut: 0.0374,
    quotePrice: 2656.12,
    referencePrice: null,
    slippageBps: 50,
    status: 'awaiting_signature',
    txHash: null,
    approvalTxHash: null,
    fillPrice: null,
    filledIn: null,
    filledOut: null,
    feePaid: null,
    feeAsset: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 0,
    submittedAt: null,
    settledAt: null,
    ...p,
  };
}

function quote(p: Partial<Quote> & { approval?: boolean } = {}): Quote {
  const { approval, ...rest } = p;
  return {
    id: `q${Math.random()}`,
    mode: 'live',
    market: 'ETH-USD',
    side: 'buy',
    network: 'robinhood-mainnet',
    venue: 'uniswap-v3',
    venueName: 'Uniswap v3',
    assetIn: 'USDG',
    assetOut: 'ETH',
    amountIn: 100,
    expectedOut: 0.0376,
    minOut: 0.0374,
    price: 2656.12,
    referenceMid: 2656,
    priceImpactBps: 1,
    slippageBps: 50,
    fees: [],
    quotedAt: 0,
    expiresAt: 20_000,
    latencyMs: 1,
    priceSource: 'test',
    simulated: false,
    account: WALLET,
    tx: {
      chainId: MAINNET.chainId,
      approval: approval ? { token: '0xusdg', spender: '0xrouter', amount: '100000000' } : null,
      swap: { to: '0xrouter', data: '0x', value: '0' },
      amountInRaw: '1',
      minOutRaw: '1',
      tokenIn: { address: '0x1', decimals: 6, symbol: 'USDG' },
      tokenOut: { address: '0x2', decimals: 18, symbol: 'ETH' },
    },
    warnings: [],
    ...rest,
  };
}

type Call = { path: string; body?: Record<string, unknown> };

/** A scripted live environment: records every call; server answers come from `answers` in order. */
function liveEnv(opts: { answers?: Record<string, unknown[]>; settle?: Partial<Order>; env?: Partial<LiveEnv>; sendFails?: unknown } = {}) {
  const calls: Call[] = [];
  const log: string[] = [];
  const phases: InstantPhase[] = [];
  const interims: unknown[] = [];
  const answers = { ...opts.answers };
  const env: LiveEnv = {
    mode: 'live',
    route: ETH_ROUTE,
    liveEnabled: true,
    wallet: { address: WALLET, chainId: MAINNET.chainId },
    verifiedWallet: WALLET,
    bid: 2500,
    slippageBps: 50,
    confirmLargeTradeUsd: 1000,
    api: (async (path: string, o?: { body?: unknown }) => {
      calls.push({ path, body: o?.body as Record<string, unknown> | undefined });
      const key = path.split('?')[0]!;
      const next = answers[key]?.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error(`unexpected call ${path}`);
      return next;
    }) as LiveEnv['api'],
    ensureChain: async (id) => void log.push(`chain:${id}`),
    signIn: async () => void log.push('siwe'),
    approve: async () => void log.push('approve'),
    signAndSubmit: async (o) => {
      log.push('send');
      if (opts.sendFails) throw opts.sendFails;
      return { order: { ...o, status: 'submitted', txHash: '0xhash' } };
    },
    settled: async (id) => order({ id, status: 'confirmed', ...opts.settle }),
    onPhase: (p, interim) => {
      phases.push(p);
      if (interim) interims.push(interim);
    },
    onOrder: () => undefined,
    ...opts.env,
  };
  return { env, calls, log, phases, interims };
}

const buy100: InstantRequest = { market: 'ETH-USD', side: 'buy', usd: 100 };

describe('sellQuantity (one-tap sell sizing)', () => {
  it('converts USD at the bid, floored to the market precision', () => {
    expect(sellQuantity(100, 2656.12, 1, 6)).toEqual({ qty: 0.037648, all: false });
    expect(sellQuantity(50, 0.121, 10_000, 0)).toEqual({ qty: 413, all: false });
  });

  it('sells everything when the holding is worth less than the amount', () => {
    expect(sellQuantity(100, 2500, 0.03, 6)).toEqual({ qty: 0.03, all: true });
  });

  it('sells everything rather than leave less than one unit behind', () => {
    expect(sellQuantity(100, 2500, 0.0400004, 6)).toEqual({ qty: 0.0400004, all: true });
    expect(sellQuantity(100, 2500, 0.040001, 6)).toEqual({ qty: 0.04, all: false });
  });

  it('Infinity means "sell all"; nothing held or nothing asked sells nothing', () => {
    expect(sellQuantity(Infinity, 2500, 0.123456789, 6)).toEqual({ qty: 0.123456789, all: true });
    expect(sellQuantity(100, 2500, 0, 6)).toEqual({ qty: 0, all: false });
    expect(sellQuantity(0, 2500, 1, 6)).toEqual({ qty: 0, all: false });
    expect(sellQuantity(0.01, 0.121, 10, 0)).toEqual({ qty: 0, all: false });
  });
});

describe('messages', () => {
  it('says what filled, in plain words', () => {
    expect(fillMessage(order({ side: 'buy', status: 'filled', filledOut: 0.03765, fillPrice: 2656.12 }))).toBe('Bought 0.03765 ETH at $2,656.12');
    expect(fillMessage(order({ side: 'sell', assetIn: 'ETH', assetOut: 'USDG', status: 'confirmed', filledIn: 0.05, fillPrice: 2655.9 }), true)).toBe('Sold all 0.05 ETH at $2,655.90');
    expect(fillMessage(order({ side: 'sell', assetIn: 'PEPE', assetOut: 'USD', status: 'filled', filledIn: 23_809_523, fillPrice: 0.00000421 }))).toBe('Sold 23,809,523 PEPE at $0.000004210');
  });

  it('turns errors into short messages, keeping the server’s words for anything unknown', () => {
    expect(failureFrom(new ApiError(503, 'stale_price', 'Market data is stale (20s since last update, feed down).'))).toEqual({ ok: false, code: 'stale_price', message: 'Market data is stale — trading paused' });
    expect(failureFrom(new ApiError(409, 'nothing_to_sell', 'You don’t hold any SOL to sell.')).message).toBe('You don’t hold any SOL to sell.');
    expect(failureFrom({ name: 'UserRejectedRequestError' })).toMatchObject({ code: 'user_rejected', message: 'Cancelled in your wallet — nothing was sent' });
    expect(failureFrom({ cause: { code: 4001 } }).code).toBe('user_rejected');
    expect(failureFrom(new Error('boom'))).toEqual({ ok: false, code: 'error', message: 'boom' });
  });
});

describe('terminal trade flow', () => {
  it('only exports the live flow; paper execution stays server-side', async () => {
    const flows = await import('./instantFlow');
    expect(flows).not.toHaveProperty('runPaper');
    expect(flows.runLive).toBeTypeOf('function');
  });
});

describe('live one-tap', () => {
  it('buy: quote → exact approval → re-quote → order → wallet → submitted → confirmed', async () => {
    const t = liveEnv({
      answers: { '/api/quotes': [{ quote: quote({ approval: true }) }, { quote: quote() }], '/api/orders': [{ order: order(), tx: quote().tx }] },
      settle: { filledOut: 0.0376, fillPrice: 2656.12 },
    });
    const r = await runLive(buy100, 'ik_live', t.env);
    expect(r).toMatchObject({ ok: true, message: 'Bought 0.0376 ETH at $2,656.12' });
    expect(t.log).toEqual(['approve', 'send']);
    expect(t.phases).toEqual(['quoting', 'approving', 'quoting', 'signing', 'submitted']);
    expect(t.interims).toEqual([expect.objectContaining({ ok: true, message: SUBMITTED_MESSAGE })]);
    expect(t.calls.map((c) => c.path)).toEqual(['/api/quotes', '/api/quotes', '/api/orders']);
    expect(t.calls[0]!.body).toMatchObject({ market: 'ETH-USD', side: 'buy', mode: 'live', amountIn: '100.000000', slippageBps: 50, account: WALLET });
    expect(t.calls[2]!.body).toEqual({ quoteId: expect.any(String), idempotencyKey: 'ik_live' });
  });

  it('switches network and signs in first when needed', async () => {
    const t = liveEnv({
      answers: { '/api/quotes': [{ quote: quote() }], '/api/orders': [{ order: order(), tx: quote().tx }] },
      env: { wallet: { address: WALLET, chainId: 1 }, verifiedWallet: null },
    });
    expect((await runLive(buy100, 'k', t.env)).ok).toBe(true);
    expect(t.log).toEqual([`chain:${MAINNET.chainId}`, 'siwe', 'send']);
    expect(t.phases.slice(0, 3)).toEqual(['signing', 'signing', 'quoting']);
  });

  it('sell: sizes at the bid, keeps gas, and sells all when that is less than the amount', async () => {
    const t = liveEnv({
      answers: {
        '/api/chain/balances': [{ balances: [{ symbol: 'ETH', amount: 0.03 + GAS_RESERVE_ETH }] }],
        '/api/quotes': [{ quote: quote({ side: 'sell', assetIn: 'ETH', assetOut: 'USDG' }) }],
        '/api/orders': [{ order: order({ side: 'sell', assetIn: 'ETH', assetOut: 'USDG' }), tx: quote().tx }],
      },
      settle: { side: 'sell', assetIn: 'ETH', assetOut: 'USDG', filledIn: 0.03, fillPrice: 2499.5 },
    });
    const r = await runLive({ market: 'ETH-USD', side: 'sell', usd: 100 }, 'k', t.env);
    expect(t.calls[1]!.body).toMatchObject({ side: 'sell', amountIn: '0.03000000' });
    expect(r).toMatchObject({ ok: true, message: 'Sold all 0.03 ETH at $2,499.50' });
  });

  it('refuses before touching the wallet: no route, live off, no wallet, nothing to sell, large trades unconfirmed', async () => {
    const noRoute = liveEnv({ env: { route: null } });
    expect(await runLive({ ...buy100, market: 'BTC-USD' }, 'k', noRoute.env)).toMatchObject({ ok: false, code: 'no_route', message: 'BTC trades on Paper only — Live supports ETH ⇄ USDG' });
    expect(await runLive(buy100, 'k', liveEnv({ env: { liveEnabled: false } }).env)).toMatchObject({ code: 'live_disabled', message: 'Live trading is off on this server' });
    expect(await runLive(buy100, 'k', liveEnv({ env: { wallet: null } }).env)).toMatchObject({ code: 'wallet_required', message: 'Connect your wallet to trade live' });

    const dust = liveEnv({ answers: { '/api/chain/balances': [{ balances: [{ symbol: 'ETH', amount: GAS_RESERVE_ETH * 0.8 }] }] } });
    expect(await runLive({ market: 'ETH-USD', side: 'sell', usd: 50 }, 'k', dust.env)).toMatchObject({ code: 'nothing_to_sell', message: `No ETH to sell (${GAS_RESERVE_ETH} ETH stays for gas)` });

    const big = liveEnv({ env: { wallet: { address: WALLET, chainId: 1 }, verifiedWallet: null } });
    const r = await runLive({ ...buy100, usd: 1500 }, 'k', big.env);
    expect(r).toMatchObject({ ok: false, code: 'confirm_required', message: '$1,500.00 is over your $1,000 limit — confirm to trade' });
    for (const t of [noRoute, dust, big]) expect(t.log).toEqual([]);
    expect(big.calls).toEqual([]);
  });

  it('a confirmed large trade goes ahead', async () => {
    const t = liveEnv({ answers: { '/api/quotes': [{ quote: quote({ amountIn: 1500 }) }], '/api/orders': [{ order: order(), tx: quote().tx }] } });
    expect((await runLive({ ...buy100, usd: 1500, confirmed: true }, 'k', t.env)).ok).toBe(true);
  });

  it('stops on quote blockers before any approval', async () => {
    const t = liveEnv({ answers: { '/api/quotes': [{ quote: quote({ approval: true, warnings: ['insufficient_balance: wallet holds 12 USDG'] }) }] } });
    expect(await runLive(buy100, 'k', t.env)).toMatchObject({ code: 'insufficient_balance', message: 'Not enough USDG in your wallet' });
    expect(t.log).toEqual([]);
    const sim = liveEnv({ answers: { '/api/quotes': [{ quote: quote({ warnings: ['simulation_failed: execution reverted'] }) }] } });
    expect(await runLive(buy100, 'k', sim.env)).toMatchObject({ code: 'simulation_failed', message: 'This swap would fail right now — nothing was sent' });
  });

  it('a wallet rejection is a quiet cancel', async () => {
    const t = liveEnv({ answers: { '/api/quotes': [{ quote: quote() }], '/api/orders': [{ order: order(), tx: quote().tx }] }, sendFails: Object.assign(new Error('User rejected the request.'), { code: 4001 }) });
    expect(await runLive(buy100, 'k', t.env)).toMatchObject({ ok: false, code: 'user_rejected' });
    expect(t.phases).not.toContain('submitted');
  });

  it('server refusals at order time (e.g. wallet mismatch) come back in plain words', async () => {
    const t = liveEnv({ answers: { '/api/quotes': [{ quote: quote() }], '/api/orders': [new ApiError(409, 'wallet_mismatch', 'This quote was built for a different (or no) wallet.')] } });
    expect(await runLive(buy100, 'k', t.env)).toMatchObject({ code: 'wallet_mismatch', message: 'Switch back to the wallet you signed in with' });
    expect(t.log).toEqual([]);
  });

  it('a revert on-chain is reported as failed', async () => {
    const t = liveEnv({ answers: { '/api/quotes': [{ quote: quote() }], '/api/orders': [{ order: order(), tx: quote().tx }] }, settle: { status: 'failed', errorCode: 'reverted', errorMessage: 'Transaction reverted on-chain.' } });
    expect(await runLive(buy100, 'k', t.env)).toMatchObject({ ok: false, code: 'reverted', message: 'Failed on-chain — no trade happened (gas was spent)' });
    expect(t.phases).toContain('submitted');
  });

  it('if the hash report fails after broadcast, it still waits for the (replayed) confirmation', async () => {
    const t = liveEnv({
      answers: { '/api/quotes': [{ quote: quote() }], '/api/orders': [{ order: order(), tx: quote().tx }] },
      sendFails: new ApiError(0, 'network', 'Cannot reach the EKO server.'),
      settle: { filledOut: 0.0376, fillPrice: 2656.12 },
    });
    expect(await runLive(buy100, 'k', t.env)).toMatchObject({ ok: true, message: 'Bought 0.0376 ETH at $2,656.12' });
    expect(t.phases).toContain('submitted');
  });
});
