import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { encodeAbiParameters, encodeEventTopics, getAddress, pad, toHex, type Address, type Hex } from 'viem';
import { loadElysiumRegistry } from '@eko/chain';
import { ELYSIUM_CHAIN_ID, MeSchema, PublicConfigSchema } from '@eko/shared';
import swaps from './fixtures/ur-swaps.json' with { type: 'json' };
import { buildSwap, Trading } from '../src/trade.js';
import { AccountStore } from '../src/accounts.js';
import { HistoryStore } from '../src/history.js';
import { swapAbi, Tracker, TRANSFER_TOPIC, type Rpc } from '../src/tracker.js';
import { Edge } from '../src/service.js';
import { HypeUsd } from '../src/hype.js';
import { buildServer } from '../src/server.js';
import type { Assessment } from '../src/assess.js';

const registry = loadElysiumRegistry();

describe('Universal Router swap', () => {
  it('encodes buys and sells byte for byte like Elysium mainnet swaps', () => {
    const key = { currency0: '0x0000000000000000000000000000000000000000', currency1: getAddress('0x4da0ff60be75fdff37bfb2252adf23ea27a9acce'), fee: 0, tickSpacing: 60,
      hooks: getAddress('0x3ab88ddc3cf2a012af88b60828edb4553697e5dc') } as const;
    const buy = buildSwap(key, 'buy', 0xad5f57690a0000n, 0x221e749f3f87752fb36cn, getAddress('0x36194cb4bba46f2f1afe24ae5576c5052c2f435d'), 1794359221n);
    expect(buy.data).toBe(swaps.buy.input); expect(buy.value.toString()).toBe(swaps.buy.value);
    const sell = buildSwap(key, 'sell', 0x2be5dfc375894bdf4n, 0xad57aae580en, getAddress('0xcc03e2f41f9ebc6ee48bf92ef4d1b3720eddd477'), 1794359221n);
    expect(sell.data).toBe(swaps.sell.input); expect(sell.value).toBe(0n);
    expect(() => buildSwap({ ...key, currency0: key.hooks }, 'buy', 1n, 1n, key.hooks, 1n)).toThrow(/native-HYPE/);
  });

  it('guards: refuses buying a confirmed honeypot, warns on Danger, pending, the early-buy fee and large impact', () => {
    const store = new HistoryStore(':memory:');
    const t = new Trading({ db: store.db, rpc: { request: async () => '0x' }, chain: registry, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 1000 });
    const a = (level: string, playbooks: { id: string; level: string }[] = [], antiSnipe: Assessment['antiSnipe'] = null) => ({ verdict: { level, playbooks }, antiSnipe }) as unknown as Assessment;
    const codes = (checks: { code: string; status: string }[]) => checks.map(c => `${c.code}:${c.status}`);
    expect(codes(t.guard(a('danger', [{ id: 'honeypot', level: 'danger' }]), 0, true))).toEqual(['honeypot:refuse', 'verdict:warn']);
    expect(codes(t.guard(a('danger', [{ id: 'honeypot', level: 'danger' }]), 0, false))).toEqual(['honeypot:warn', 'verdict:warn']);
    expect(codes(t.guard(a('clear'), 0, true))).toEqual(['honeypot:pass', 'verdict:pass']);
    expect(codes(t.guard(a('pending', [], { taxPct: 20, endsInSec: 30 }), 1500, true))).toEqual(['honeypot:pass', 'verdict:warn', 'anti_snipe:warn', 'price_impact:warn']);
  });
});

describe('wallet sign-in', () => {
  it('signs in with a SIWE signature, serves /me and the watchlist, refuses replays and cross-site writes, and signs out', async () => {
    const store = new HistoryStore(':memory:'), accounts = new AccountStore(store.db);
    const rpc: Rpc = { request: async () => { throw new Error('no rpc'); } };
    const tracker = new Tracker(rpc, registry);
    const edge = new Edge(tracker, rpc, registry, new HypeUsd(async () => new Response('{}')));
    const trading = new Trading({ db: store.db, rpc, chain: registry, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 500 });
    const app = buildServer(edge, { store, accounts, trading, maxTradeUsd: 500 });
    const host = 'eko.test', headers = { host, 'content-type': 'application/json' };
    expect((await app.inject({ url: '/v1/me', headers: { host } })).statusCode).toBe(401);
    expect(PublicConfigSchema.parse((await app.inject({ url: '/v1/config' })).json()).trading).toMatchObject({ liveEnabled: true, maxTradeUsd: 500, routers: [registry.address('uniswapV4.universalRouter212').toLowerCase()] });

    // A throwaway key made for this test.
    const wallet = privateKeyToAccount(generatePrivateKey());
    const sign = async () => {
      const n = (await app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: { host } })).json();
      const message = createSiweMessage({ domain: n.domain, address: wallet.address, statement: 'Sign in to EKO.', uri: n.uri, version: '1', chainId: ELYSIUM_CHAIN_ID, nonce: n.nonce,
        issuedAt: new Date(n.issuedAt), expirationTime: new Date(n.expirationTime) });
      return { message, signature: await wallet.signMessage({ message }) };
    };
    const signed = await sign();
    const verified = await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers, payload: signed });
    expect(verified.statusCode).toBe(200);
    expect(MeSchema.parse(verified.json()).account.wallet).toBe(wallet.address.toLowerCase());
    const cookie = String(verified.headers['set-cookie']).split(';')[0]!;
    expect(cookie).toMatch(/^eko_session=/);
    expect(String(verified.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Lax/);
    // The same signed message (same nonce) cannot sign in twice.
    expect((await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers, payload: signed })).statusCode).toBe(401);
    // Someone else's signature over this wallet's message fails.
    const other = privateKeyToAccount(generatePrivateKey()), forged = await sign();
    expect((await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers, payload: { message: forged.message, signature: await other.signMessage({ message: forged.message }) } })).statusCode).toBe(401);

    const authed = { ...headers, cookie };
    expect((await app.inject({ url: '/v1/me', headers: authed })).json().account.wallet.toLowerCase()).toBe(wallet.address.toLowerCase());
    const coin = '0xabababababababababababababababababababab' as Address;
    expect((await app.inject({ method: 'POST', url: '/v1/watch', headers: authed, payload: { kind: 'coin', target: coin } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/watch', headers: authed })).json().items).toEqual([{ kind: 'coin', target: coin }]);
    // A write from another site is refused before it reaches a route.
    expect((await app.inject({ method: 'POST', url: '/v1/watch', headers: { ...authed, origin: 'https://evil.example' }, payload: { kind: 'coin', target: coin } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/v1/watch', headers: authed, payload: { kind: 'coin', target: coin } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/watch', headers: authed })).json().items).toEqual([]);
    // Orders need a session; a quote for a coin EKO does not follow is a clear 404.
    expect((await app.inject({ method: 'POST', url: '/v1/trade/order', headers, payload: { quoteId: 'q', idempotencyKey: 'k', acknowledged: [] } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/trade/quote', headers: authed, payload: { coin, side: 'buy', amountUsd: 10, slippageBps: 300 } })).json()).toMatchObject({ error: 'not_found' });
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { host, cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/me', headers: authed })).statusCode).toBe(401);
    await app.close();
  });
});

describe('order settlement records what the wallet paid and got (fork run: history showed the pool amount, before Montra\'s 1% fee)', () => {
  const wallet = '0x00000000000000000000000000000000000a11ce', coin = '0xabababababababababababababababababababab';
  const pm = registry.address('uniswapV4.poolManager');
  const swapLog = (amount0: bigint, amount1: bigint) => ({ address: pm, topics: encodeEventTopics({ abi: swapAbi, eventName: 'Swap', args: { id: pad('0x01'), sender: registry.address('uniswapV4.universalRouter212') } }) as Hex[],
    data: encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [amount0, amount1, 1n, 1n, 0, 0]) });
  const transfer = (from: string, to: string, v: bigint) => ({ address: coin, topics: [TRANSFER_TOPIC, pad(from as Hex), pad(to as Hex)] as Hex[], data: pad(toHex(v)) });
  const settle = async (side: 'buy' | 'sell', amountIn: bigint, logs: unknown[], balances?: Record<string, bigint> | 'unreadable', updatedAt = Math.floor(Date.now() / 1000)) => {
    const store = new HistoryStore(':memory:');
    const rpc: Rpc = { request: async ({ method, params }) => {
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x64', gasUsed: '0x2710', effectiveGasPrice: '0x3', logs };
      if (method === 'eth_getBalance' && balances && balances !== 'unreadable') return toHex(balances[(params as string[])[1]!]!);
      throw new Error(`no ${method}`);
    } };
    const t = new Trading({ db: store.db, rpc, chain: registry, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
    store.db.prepare(`INSERT INTO orders(id, account_id, wallet, quote_id, idem, coin, side, amount_in, min_out, status, tx_hash, created_at, updated_at)
      VALUES('ord_1', 'acct_1', ?, 'q', 'i', ?, ?, ?, '1', 'submitted', ?, 0, ?)`).run(wallet, coin, side, amountIn.toString(), `0x${'1'.repeat(64)}`, updatedAt);
    await t.reconcile();
    return t.get('acct_1', 'ord_1')!;
  };

  it('built transactions are for Elysium (99901), the chain the wallet signs on', () => {
    const t = new Trading({ db: new HistoryStore(':memory:').db, rpc: { request: async () => { throw new Error("none"); } }, chain: registry, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
    const txs = t.approvalTxs({ approvals: [{ kind: 'erc20', token: coin, spender: pm, amount: '1' }, { kind: 'permit2', token: coin, spender: pm, amount: '1', expiration: 1 }] } as never);
    expect(txs.map(x => x.chainId)).toEqual([ELYSIUM_CHAIN_ID, ELYSIUM_CHAIN_ID]);
  });

  it('a buy paid the whole transaction value, fee included, not just what reached the pool', async () => {
    // Paid 1.0 HYPE; the pool took 0.99 after the 1% fee; the coins arrived at the wallet.
    const o = await settle('buy', 10n ** 18n, [swapLog(-(99n * 10n ** 16n), 500n), transfer(pm, wallet, 500n)]);
    expect(o).toMatchObject({ status: 'confirmed', filledIn: (10n ** 18n).toString(), filledOut: '500' });
  });

  it('a sell got the HYPE that reached the wallet (balance change plus gas), not the pool amount before the fee', async () => {
    const gas = 0x2710n * 3n;
    const o = await settle('sell', 500n, [transfer(wallet, pm, 500n), swapLog(10n ** 18n, -500n)], { '0x63': 5n * 10n ** 18n, '0x64': 5n * 10n ** 18n + 99n * 10n ** 16n - gas });
    expect(o).toMatchObject({ status: 'confirmed', filledIn: '500', filledOut: (99n * 10n ** 16n).toString() });
  });

  it('retries unreadable balances on a later pass, then falls back to the pool amount; ignores changes that do not add up', async () => {
    const sold = [transfer(wallet, pm, 500n), swapLog(10n ** 18n, -500n)];
    expect(await settle('sell', 500n, sold, 'unreadable')).toMatchObject({ status: 'submitted' });
    expect(await settle('sell', 500n, sold, 'unreadable', Math.floor(Date.now() / 1000) - 120)).toMatchObject({ status: 'confirmed', filledOut: (10n ** 18n).toString() });
    // Other HYPE arrived in the same block: more than the pool paid out is not this sell's.
    expect((await settle('sell', 500n, [transfer(wallet, pm, 500n), swapLog(10n ** 18n, -500n)], { '0x63': 0n, '0x64': 3n * 10n ** 18n })).filledOut).toBe((10n ** 18n).toString());
  });
});
