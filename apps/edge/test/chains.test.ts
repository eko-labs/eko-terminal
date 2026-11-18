import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { loadElysiumRegistry, v4PoolId } from '@eko/chain';
import { ELYSIUM_CHAIN_ID, PublicConfigSchema, ROBINHOOD_CHAIN_ID, UnsignedTxSchema, type SupportedChainId, type TradeQuote } from '@eko/shared';
import { AccountStore } from '../src/accounts.js';
import { AgentStore, PRESETS } from '../src/agents.js';
import type { Assessment } from '../src/assess.js';
import { chainKeyFrom, ELYSIUM_PROFILE, loadChain, PROFILES, ROBINHOOD_PROFILE } from '../src/chains/index.js';
import { chainOf } from '../src/chains/elysium/index.js';
import { loadRobinhoodTradeAddresses, ponsPoolKey } from '../src/chains/robinhood/trade.js';
import gradFx from './fixtures/robinhood/pons-graduation.json' with { type: 'json' };
import type { ChainAdapter, TradeRoute } from '../src/chains/types.js';
import { graduationBps } from '../src/graduation.js';
import { HistoryStore } from '../src/history.js';
import { HypeUsd } from '../src/hype.js';
import { mcpTools } from '../src/mcp.js';
import { buildServer } from '../src/server.js';
import { Edge } from '../src/service.js';
import { NO_POOL, swapAbi, Tracker, type CoinState, type RawLog, type Rpc } from '../src/tracker.js';
import { Trading, v4QuoterAbi } from '../src/trade.js';
import { publicConfig } from '../src/views.js';

const registry = loadElysiumRegistry();
const elysium = chainOf(registry);
/** Elysium's code under Robinhood Chain's profile: what changes with the profile alone (ids, text, venue). */
const asRobinhood: ChainAdapter = { ...elysium, profile: ROBINHOOD_PROFILE };
const COIN = getAddress('0xabababababababababababababababababababab');
const WALLET = getAddress('0x00000000000000000000000000000000000a11ce');
const lower = (a: string) => a.toLowerCase();
const noRpc: Rpc = { request: async () => { throw new Error('no rpc'); } };

describe('EKO_CHAIN', () => {
  it('defaults to Elysium, takes either chain, and stops on anything else', () => {
    expect(chainKeyFrom(undefined)).toBe('elysium');
    expect(chainKeyFrom('')).toBe('elysium');
    expect(chainKeyFrom(' elysium ')).toBe('elysium');
    expect(chainKeyFrom('robinhood')).toBe('robinhood');
    for (const bad of ['Robinhood', 'rhc', '4663', 'base', 'elysium,robinhood']) expect(() => chainKeyFrom(bad)).toThrow(/EKO_CHAIN must be one of elysium, robinhood/);
  });
  it('profiles carry each chain\'s id, native coin and price symbol, and both chains load', () => {
    expect(PROFILES.elysium).toMatchObject({ id: ELYSIUM_CHAIN_ID, native: 'HYPE', venue: 'elysium', outcomeVersion: 'elysium-1', price: { symbol: 'HYPE' } });
    expect(PROFILES.robinhood).toMatchObject({ id: ROBINHOOD_CHAIN_ID, native: 'ETH', venue: 'rhc', outcomeVersion: 'robinhood-1', price: { symbol: 'ETH' } });
    for (const p of Object.values(PROFILES)) expect(p.chain.id).toBe(p.id);
    expect(loadChain('elysium').profile).toBe(ELYSIUM_PROFILE);
    expect(loadChain('robinhood').profile).toBe(ROBINHOOD_PROFILE);
  });
  it('the backfill default is the profile\'s, or seconds over the block time: 32,400 blocks on Elysium as before', async () => {
    const rpc: Rpc = { request: async ({ method }) => { if (method === 'eth_blockNumber') return toHex(1_000_000); throw new Error('stop'); } };
    const cursorOf = async (chain: ChainAdapter) => { const t = new Tracker(rpc, chain); await t.start().catch(() => undefined); return 1_000_000 - Number(t.cursor); };
    expect(await cursorOf(elysium)).toBe(32_400);
    // Robinhood Chain sets its own (32,400 blocks: 55 minutes at 0.102 s).
    expect(await cursorOf(asRobinhood)).toBe(32_400);
  });
  it('the native price is read by the profile\'s symbol', async () => {
    const mids = async () => new Response(JSON.stringify({ HYPE: '40', ETH: '3000' }));
    expect(await new HypeUsd(mids).get()).toBe(40);
    expect(await new HypeUsd(mids, ROBINHOOD_PROFILE.price.url, 30_000, () => Date.now(), ROBINHOOD_PROFILE.price.symbol).get()).toBe(3000);
  });
});

describe('publicConfig.chain', () => {
  it('reports the deployment\'s chain for both chains', async () => {
    expect(PublicConfigSchema.parse(publicConfig()).chain).toEqual({ key: 'elysium', id: 99901, name: 'Elysium', native: 'HYPE',
      explorerUrl: ELYSIUM_PROFILE.explorerUrl, publicRpcUrl: ELYSIUM_PROFILE.publicRpc });
    expect(PublicConfigSchema.parse(publicConfig(undefined, {}, ROBINHOOD_PROFILE)).chain).toMatchObject({ key: 'robinhood', id: 4663, name: 'Robinhood Chain', native: 'ETH' });
    for (const chain of [elysium, asRobinhood]) {
      const app = buildServer(new Edge(new Tracker(noRpc, chain), noRpc, chain, new HypeUsd(async () => new Response('{}'))));
      expect(PublicConfigSchema.parse((await app.inject({ url: '/v1/config' })).json()).chain).toMatchObject({ key: chain.profile.key, id: chain.profile.id });
    }
  });
  it('lists the routers and spenders the venue uses, and every approval a quote asks for passes the web\'s check', async () => {
    const rhChain = loadChain('robinhood'), a = loadRobinhoodTradeAddresses(), v = rhChain.trade;
    // Curves are one per coin: none is listed. The v4 route's router and Permit2 are.
    const config = PublicConfigSchema.parse(publicConfig({ ...v, maxTradeUsd: 100 }, {}, ROBINHOOD_PROFILE)).trading;
    expect(config).toMatchObject({ routers: [lower(a.universalRouter)], spenders: [lower(a.permit2)], permit2: lower(a.permit2) });
    // The web's rule (apps/web/src/lib/tradeFlow.ts): an ERC-20 approval's spender is a listed spender, or the quote's own
    // curve (route venue pons_curve, poolId the curve) for the quote's coin; a Permit2 allowance goes to a listed router;
    // the transaction calls a listed router or that curve.
    const curve = getAddress('0x00000000000000000000000000000000000000c0');
    const webAccepts = (q: TradeQuote, txTo: string) => {
      const ponsCurve = q.route.venue === 'pons_curve' ? q.route.poolId : null;
      const ok = (x: string, list: string[]) => list.some(y => lower(y) === lower(x));
      return q.approvals.every(s => s.kind === 'permit2' ? ok(s.spender, config.routers) && ok(s.token, [q.coin])
        : ok(s.spender, config.spenders) || (!!ponsCurve && ok(s.spender, [ponsCurve]) && ok(s.token, [q.coin]))) && (ok(txTo, config.routers) || (!!ponsCurve && ok(txTo, [ponsCurve])));
    };
    const key = ponsPoolKey(COIN, getAddress(a.ponsHook));
    for (const graduated of [false, true]) {
      const coin = { token: COIN, graduated, key: graduated ? key : null, poolId: graduated ? v4PoolId(key) : NO_POOL, manager: a.poolManager, curve: { address: curve }, trades: [{ priceHype: 1e-9 }] } as unknown as CoinState;
      const chain: ChainAdapter = { ...rhChain, trade: { ...v, quote: async () => ({ expectedOut: 10n ** 15n, priceImpactBps: 5 }) } };
      // A wallet holding plenty of the coin and no allowances.
      const rpc: Rpc = { request: async ({ method, params }) => method === 'eth_gasPrice' ? '0x1'
        : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [(params[0] as { data: string }).data.startsWith('0x70a08231') ? 10n ** 24n : 0n, 0n, 0n]) };
      const assessment = { key: coin.key, verdict: { level: 'clear', playbooks: [] }, probe: { exitCostPct: 1 }, block: 1, taxPct: null, currentBuyFeePips: null, config: null, antiSnipe: null } as unknown as Assessment;
      const t = new Trading({ db: new HistoryStore(':memory:').db, rpc, chain, coin: () => coin, assess: async () => assessment, hypeUsd: () => 2000, maxTradeUsd: 250 });
      const q = await t.quote({ coin: COIN, side: 'sell', amountUsd: 1, slippageBps: 300 }, WALLET);
      expect(q.route).toMatchObject(graduated ? { venue: 'uniswap_v4', poolId: v4PoolId(key) } : { venue: 'pons_curve', poolId: curve });
      expect(q.approvals.map(x => `${x.kind}:${lower(x.spender)}`)).toEqual(graduated ? [`erc20:${lower(a.permit2)}`, `permit2:${lower(a.universalRouter)}`] : [`erc20:${lower(curve)}`]);
      const stored = (t as unknown as { quotes: Map<string, { route: TradeRoute }> }).quotes.get(q.id)!;
      expect(webAccepts(q, v.build(stored.route, 'sell', BigInt(q.amountIn), BigInt(q.minOut), 1n, WALLET).to)).toBe(true);
      expect(t.approvalTxs(q).every(x => x.chainId === ROBINHOOD_CHAIN_ID)).toBe(true);
    }
    const t = new Trading({ db: new HistoryStore(':memory:').db, rpc: noRpc, chain: elysium, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
    expect(PublicConfigSchema.parse(publicConfig({ ...t, maxTradeUsd: 250 })).trading).toMatchObject({ routers: [lower(registry.address('uniswapV4.universalRouter212'))], spenders: [lower(registry.address('uniswapV4.permit2'))] });
  });
});

describe('the Robinhood adapter', () => {
  it('follows a Pons coin from launch along its curve to graduation, then counts its pool\'s swaps', () => {
    const chain = loadChain('robinhood'), tracker = new Tracker(noRpc, chain);
    expect(chain.queries).toHaveLength(2);
    const fx = gradFx as unknown as { token: Address; curve: Address; launch: RawLog; curveLogs: RawLog[]; initialize: RawLog; mints: RawLog[] };
    tracker.applyAll([fx.launch, ...fx.mints, ...fx.curveLogs, fx.initialize], (l) => 1_763_000_000 + Number(BigInt(l.blockNumber)) % 100_000);
    const coin = tracker.coin(fx.token)!;
    expect(coin).toMatchObject({ launchpad: 'pons', graduated: true, key: { currency1: getAddress(fx.token), fee: 0, tickSpacing: 200 } });
    expect(coin.trades.length).toBeGreaterThan(10);
    expect(coin.curve!.realQuoteReserve).toBeGreaterThanOrEqual(coin.curve!.graduationThreshold);
    expect(graduationBps(coin)).toBe(10_000);
    expect(tracker.coinByPool(fx.curve)).toBe(coin);
    expect(tracker.coinByPool(coin.poolId)).toBe(coin);
    expect(tracker.feed.map(e => e.kind)).toEqual(['new_pair', 'graduation']);
    // The curve, factory, router, hook, PoolManager and locker hold coins without being holders.
    expect(chain.excluded(coin).map(lower)).toContain(lower(fx.curve));
  });
  it('marks the launch snipe tax (9,900, 618, 19 bps by second) and redoes a probe taken inside it', () => {
    const chain = loadChain('robinhood');
    const coin = { ts: 1000, graduated: false, curve: { address: COIN } } as unknown as CoinState;
    const probed = { key: null, pons: null, lock: null } as unknown as Parameters<ChainAdapter['facts']>[1];
    expect([1000, 1001, 1002, 1003].map(now => chain.facts(coin, probed, now).antiSnipe)).toEqual([
      { taxPct: 99, endsInSec: 3 }, { taxPct: 6.18, endsInSec: 2 }, { taxPct: 0.19, endsInSec: 1 }, null]);
    expect(chain.facts({ ...coin, graduated: true } as CoinState, probed, 1000).antiSnipeActive).toBe(false);
  });
});

describe('sign-in names the deployment\'s chain', () => {
  const signIn = async (chain: ChainAdapter, chainId: number) => {
    const store = new HistoryStore(':memory:'), accounts = new AccountStore(store.db);
    const app = buildServer(new Edge(new Tracker(noRpc, chain), noRpc, chain, new HypeUsd(async () => new Response('{}'))), { store, accounts });
    const host = 'eko.test', wallet = privateKeyToAccount(generatePrivateKey()); // a throwaway key made for this test
    const n = (await app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: { host } })).json();
    const message = createSiweMessage({ domain: n.domain, address: wallet.address, uri: n.uri, version: '1', chainId, nonce: n.nonce, issuedAt: new Date(n.issuedAt) });
    return (await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers: { host, 'content-type': 'application/json' }, payload: { message, signature: await wallet.signMessage({ message }) } })).statusCode;
  };
  it('Elysium accepts 99901 and refuses Robinhood Chain\'s 4663', async () => {
    expect(await signIn(elysium, ROBINHOOD_CHAIN_ID)).toBe(401);
    expect(await signIn(elysium, ELYSIUM_CHAIN_ID)).toBe(200);
  });
  it('Robinhood Chain accepts 4663 and refuses Elysium\'s 99901', async () => {
    expect(await signIn(asRobinhood, ELYSIUM_CHAIN_ID)).toBe(401);
    expect(await signIn(asRobinhood, ROBINHOOD_CHAIN_ID)).toBe(200);
  });
});

describe('built transactions carry the profile\'s chain id', () => {
  const key = { currency0: zeroAddress, currency1: COIN, fee: 0, tickSpacing: 60, hooks: zeroAddress } as const;
  const coin = { token: COIN, manager: registry.address('uniswapV4.poolManager'), poolId: v4PoolId(key), trades: [{ priceHype: 0.001 }] } as unknown as CoinState;
  const assessment = { key, verdict: { level: 'clear', playbooks: [] }, probe: { exitCostPct: 1 }, block: 1, taxPct: null, currentBuyFeePips: null, config: null, antiSnipe: null } as unknown as Assessment;
  const rpc: Rpc = { request: async ({ method, params }) => {
    if (method === 'eth_gasPrice') return '0x1';
    const call = params[0] as { to: string; data: Hex };
    if (call.to.toLowerCase() === registry.address('uniswapV4.v4Quoter').toLowerCase()) return encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', result: [10n ** 21n, 100_000n] });
    if (call.data.startsWith('0x70a08231')) return encodeAbiParameters([{ type: 'uint256' }], [10n ** 24n]); // balanceOf
    return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [0n, 0n, 0n]); // no allowances (ERC-20 and Permit2); the simulation passes
  } };
  const trade = async (chain: ChainAdapter, expected: SupportedChainId) => {
    const t = new Trading({ db: new HistoryStore(':memory:').db, rpc, chain, coin: () => coin, assess: async () => assessment, hypeUsd: () => 30, maxTradeUsd: 250 });
    const buy = await t.quote({ coin: COIN, side: 'buy', amountUsd: 30, slippageBps: 300 }, WALLET);
    const { tx } = await t.order('acct_x', WALLET, { quoteId: buy.id, idempotencyKey: `k-${expected}`, acknowledged: [] });
    expect(UnsignedTxSchema.parse(tx).chainId).toBe(expected);
    const sell = await t.quote({ coin: COIN, side: 'sell', amountUsd: 30, slippageBps: 300 }, WALLET);
    const approvals = t.approvalTxs(sell);
    expect(approvals.map(a => a.chainId)).toEqual([expected, expected]);
    for (const a of approvals) UnsignedTxSchema.parse(a);
  };
  it('on Elysium (99901)', async () => trade(elysium, ELYSIUM_CHAIN_ID));
  it('on Robinhood Chain (4663)', async () => trade(asRobinhood, ROBINHOOD_CHAIN_ID));
  it('and MCP\'s trade_prepare reports it, with per-chain text and the approval venue', async () => {
    for (const chain of [elysium, asRobinhood]) {
      const store = new HistoryStore(':memory:'), agents = new AgentStore(new AccountStore(store.db).db);
      const agent = agents.create('acct_x', 'Bot', 'onchain', PRESETS[1]!.policy);
      agents.setWallet(agent.id, WALLET);
      const verdict = { coin: COIN.toLowerCase(), level: 'clear', reasons: [], playbooks: [] };
      const trading = { quote: async () => ({ id: 'q_1', coin: COIN, side: 'buy', amountIn: '1', expectedOut: '2', minOut: '1', priceImpactBps: 1, guard: { decision: 'allow', checks: [] } }),
        approvalTxs: () => [], order: async () => ({ order: { id: 'ord_1' }, tx: { chainId: chain.profile.id, to: zeroAddress, data: '0x', value: '0' } }) } as unknown as Trading;
      const edge = { tracker: { coin: () => ({}) as CoinState }, fresh: async () => ({ verdict, probe: { exitCostPct: 1 } }), chain } as unknown as Edge;
      const tools = new Map(mcpTools({ edge, agents, trading }).map(t => [t.name, t]));
      expect(tools.get('coin_verdict')!.description).toContain(`${chain.profile.text.token} on ${chain.profile.name}`);
      const row = agents.byId(agent.id)!;
      await tools.get('preflight')!.run({ clientOrderRef: 'order-0001', coin: COIN, side: 'buy', notionalUsd: 300 }, row); // above the approval line
      expect(agents.pendingApprovals(agent.id)).toBe(1);
      const approval = (store.db.prepare('SELECT detail FROM approvals').get() as { detail: string }).detail;
      expect(JSON.parse(approval).order.venue).toBe(chain.profile.venue);
      await tools.get('preflight')!.run({ clientOrderRef: 'order-0002', coin: COIN, side: 'buy', notionalUsd: 100 }, row);
      const out = await tools.get('trade_prepare')!.run({ preflightClientOrderRef: 'order-0002', coin: COIN, side: 'buy', amountUsd: 100 }, row) as { chainId: number; tx: { chainId: number } };
      expect(out.chainId).toBe(chain.profile.id);
      expect(out.tx.chainId).toBe(chain.profile.id);
    }
  });
});

describe('a bonding-curve coin', () => {
  it('is found by its curve, measured on it, and after graduation trades through the v4 Swap path', () => {
    const tracker = new Tracker(noRpc, elysium);
    const curve = getAddress('0x00000000000000000000000000000000000000c0'), tx = keccak256(toHex('launch'));
    const log = (block: number, i: number, extra: Partial<RawLog> = {}): RawLog => ({ address: curve, topics: [], data: '0x', blockNumber: toHex(block), transactionHash: tx, logIndex: toHex(i), ...extra });
    const coin: CoinState = { launchpad: 'pons', key: null, flipped: false, supplyFromMints: false, launcher: curve, manager: zeroAddress, token: COIN, creator: WALLET, poolId: NO_POOL,
      quote: zeroAddress, supply: 10n ** 27n, configId: 0n, firstBuyIn: 0n, firstBuyOut: 0n, feeRecipient: WALLET, feeLocked: false, block: 10, ts: 1000, tx, trades: [], netHype: 0,
      sqrtPriceX96: null, graduated: false, name: null, symbol: null, flows: [],
      curve: { address: curve, graduationThreshold: 4n * 10n ** 18n, realQuoteReserve: 10n ** 18n, realTokenReserve: 0n } };
    expect(tracker.launch(coin, log(10, 0))).toBe(true);
    expect(tracker.coinByPool(curve)).toBe(coin);
    expect(tracker.coinByPool(NO_POOL)).toBeUndefined();
    expect(graduationBps(coin)).toBe(2500);
    // Graduation: the chain's handler gives it its v4 pool and links it.
    const key = { currency0: zeroAddress, currency1: COIN, fee: 0, tickSpacing: 60, hooks: zeroAddress } as const, poolId = v4PoolId(key), manager = registry.address('uniswapV4.poolManager');
    Object.assign(coin, { key, poolId, manager });
    tracker.link(poolId, coin); tracker.graduate(coin, 1100, log(20, 0));
    expect(graduationBps(coin)).toBe(10_000);
    expect(tracker.feed.map(e => e.kind)).toEqual(['new_pair', 'graduation']);
    const swap: RawLog = { address: manager, topics: encodeEventTopics({ abi: swapAbi, eventName: 'Swap', args: { id: poolId, sender: WALLET } }) as Hex[],
      data: encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [-(10n ** 17n), 10n ** 21n, 2n ** 96n, 1n, 0, 0]),
      blockNumber: toHex(21), transactionHash: keccak256(toHex('buy')), logIndex: toHex(0) };
    tracker.applyAll([swap], () => 1101);
    expect(coin.trades).toHaveLength(1);
    expect(coin.trades[0]).toMatchObject({ side: 'buy', hype: 0.1 });
  });
});
