import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, padHex, type PublicClient } from 'viem';
import { binary, type SqlClient } from '@eko/db';
import { loadRegistry } from '@eko/chain';
import type { GuardAssessmentV2, Verdict } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buyVerdictGateFor, currentVerdictGate, guardReceiptFor, liveTradeBackend, liveTradeSources, readModelVerdicts, routeTerms, V3ActualOrderProbe, type TradeVerdict } from '../src/exec/live-trade.js';
import { SellGuard } from '../src/exec/sell-guard.js';
import type { ChainDb } from '@eko/db';
import { ROUTER_ABI } from '../src/exec/v3-routes.js';
import { PonsActualOrderProbe, VenueActualOrderProbe } from '../src/exec/pons-trade.js';
import { binding, stateFor } from '../../../packages/policy/test/actual-fixtures.js';
import { verdict as legacyVerdict } from '../../../packages/policy/test/fixtures.js';
import { guardFixture } from '../../../packages/policy/test/guard-fixtures.js';

// Offline: construction and gating only, injected readers, no chain or simulation host.
const registry = loadRegistry();
const WETH = registry.requireAddress('tokens.WETH').toLowerCase() as `0x${string}`;
const USDG = registry.requireAddress('tokens.USDG').toLowerCase() as `0x${string}`;
const ROUTER = registry.requireAddress('uniswapV3.swapRouter02');
const deps = { chains: () => { throw new Error('no chain reads at construction'); }, sql: () => { throw new Error('no SQL at construction'); },
  verdict: async () => ({ verdict: undefined, guardV2Active: false, scanPending: false }) };
const fetchSpy = vi.spyOn(globalThis, 'fetch');
afterEach(() => fetchSpy.mockClear());

describe('live trade backend wiring (fail-closed)', () => {
  it('installs nothing while LIVE_TRADING_ENABLED is off, whatever else is configured', () => {
    const off = liveTradeBackend({ LIVE_TRADING_ENABLED: false, RPC_HTTP_URL: 'https://rpc.example.invalid', RH_MAINNET_RPC_URL: undefined, ANVIL_FORK_URL: 'http://sim.example.invalid:8545' }, deps);
    expect(off).toEqual({ unavailable: 'Actual-account trade acquisition is unavailable', missing: ['LIVE_TRADING_ENABLED'] });
  });
  it('refuses with a named reason when the pinned-block RPC or the simulation host is missing', () => {
    const bare = liveTradeBackend({ LIVE_TRADING_ENABLED: true, RPC_HTTP_URL: undefined, RH_MAINNET_RPC_URL: undefined, ANVIL_FORK_URL: undefined }, deps);
    expect(bare.backend).toBeUndefined();
    expect(bare.missing).toEqual(['RPC_HTTP_URL', 'ANVIL_FORK_URL']);
    expect(bare.unavailable).toMatch(/not configured/);
    expect(liveTradeBackend({ LIVE_TRADING_ENABLED: true, RPC_HTTP_URL: undefined, RH_MAINNET_RPC_URL: 'https://rpc.example.invalid', ANVIL_FORK_URL: undefined }, deps).missing).toEqual(['ANVIL_FORK_URL']);
  });
  it('builds quote, probe and reconciliation without any request when fully configured', () => {
    const live = liveTradeBackend({ LIVE_TRADING_ENABLED: true, RPC_HTTP_URL: undefined, RH_MAINNET_RPC_URL: 'https://rpc.example.invalid', ANVIL_FORK_URL: 'http://sim.example.invalid:8545' }, deps);
    // The venue hook: one backend whose probe picks the v3 pool probe or the Pons-curve probe by the order's exact bytes.
    expect(live.backend).toMatchObject({ quote: expect.any(Function), capture: expect.any(Function), probe: expect.any(VenueActualOrderProbe), reconciliation: { supports: expect.any(Function) } });
    expect(live.backend!.probe).toMatchObject({ pools: expect.any(V3ActualOrderProbe), pons: expect.any(PonsActualOrderProbe) });
    expect(live.missing).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('v1 quote refusals through the real app wiring', () => {
  const origin = 'https://app.eko.example', secret = 'live-trade-fixture-placeholder'.repeat(2);
  let off: Awaited<ReturnType<typeof buildApp>>, unconfigured: Awaited<ReturnType<typeof buildApp>>;
  const base = { NODE_ENV: 'test', PGLITE_DIR: ':memory:', PUBLIC_ORIGIN: origin, SESSION_SECRET: secret, DEMO_SECRET: secret };
  beforeAll(async () => {
    off = await buildApp(loadConfig(base), { startBackground: false });
    unconfigured = await buildApp(loadConfig({ ...base, LIVE_TRADING_ENABLED: 'true' }), { startBackground: false });
  });
  afterAll(async () => { await off.close(); await unconfigured.close(); });
  const quote = async (app: typeof off) => {
    const guest = await app.app.inject('/v1/me');
    const cookie = `eko_sid=${guest.cookies.find(c => c.name === 'eko_sid')!.value}`;
    return app.app.inject({ method: 'POST', url: '/v1/trade/quote', headers: { cookie, origin }, payload: { coin: USDG, side: 'buy', amountUsd: 5, slippageBps: 50 } });
  };
  it('keeps today’s refusal while live trading is off, and names the missing setup when it is on', async () => {
    expect((await quote(off)).json()).toEqual({ error: 'sim_unavailable', message: 'Actual-account trade acquisition is unavailable' });
    const refused = await quote(unconfigured);
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: 'sim_unavailable', message: expect.stringMatching(/not configured/) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('live trade sources and probes', () => {
  const pool = padHex('0x51', { size: 20 }), coin = padHex('0x10', { size: 20 }), coinPool = padHex('0x52', { size: 20 });
  const rows: Record<string, { id: string; currency0: string; currency1: string; fee: number }[]> = {
    [WETH]: [{ id: pool, currency0: WETH, currency1: USDG, fee: 500 },
      // Look-alikes: any contract can emit Initialize. One claims a deeper pool at a false price, one reverts, one has a non-tier fee.
      { id: padHex('0x61', { size: 20 }), currency0: WETH, currency1: USDG, fee: 3000 },
      { id: padHex('0x62', { size: 20 }), currency0: WETH, currency1: USDG, fee: 100 },
      { id: padHex('0x63', { size: 20 }), currency0: WETH, currency1: USDG, fee: 83 }],
    [coin]: [{ id: coinPool, currency0: coin, currency1: WETH, fee: 3000 }],
  };
  const sql: SqlClient = { query: async (_q: string, params?: unknown[]) => {
    const key = `0x${Buffer.from(params![0] as Uint8Array).toString('hex')}`;
    return { rows: (rows[key] ?? []).map(r => ({ id: binary(r.id), currency0: binary(r.currency0), currency1: binary(r.currency1), fee: r.fee })) as never[] };
  } };
  // 1 WETH = 2,000 USDG (raw 2e9 per 1e18); 1 coin (18 decimals) = 0.001 WETH.
  const sqrt = (ratio: number) => BigInt(Math.round(Math.sqrt(ratio) * 2 ** 96));
  const client = {
    readContract: vi.fn(async (a: { functionName: string; address: string }) => {
      if (a.functionName === 'decimals') return a.address.toLowerCase() === USDG ? 6 : 18;
      if (a.functionName === 'getPool') {
        const [x, y, fee] = (a as unknown as { args: [string, string, number] }).args.map(v => typeof v === 'string' ? v.toLowerCase() : v) as [string, string, number];
        const pair = [x, y].sort().join(':');
        if (pair === [WETH, USDG].map(v => v.toLowerCase()).sort().join(':') && fee === 500) return pool;
        if (pair === [coin, WETH].map(v => v.toLowerCase()).sort().join(':') && fee === 3000) return coinPool;
        return '0x0000000000000000000000000000000000000000';
      }
      if (a.address === padHex('0x62', { size: 20 })) throw new Error('execution reverted');
      if (a.functionName === 'liquidity') return a.address === padHex('0x61', { size: 20 }) ? 10n ** 30n : 10n ** 18n;
      if (a.functionName === 'slot0') return [a.address === pool ? sqrt(2e9 / 1e18) : sqrt(1e-3), 0, 0, 0, 0, 0, true];
      throw new Error(`unexpected ${a.functionName}`);
    }),
    getBlock: vi.fn(async () => ({ baseFeePerGas: 10n })),
    simulateContract: vi.fn(async () => ({ result: [7n, 10n, 0n] })),
  } as unknown as PublicClient;
  const sources = liveTradeSources(() => client, () => sql);

  it('prices USDG at $1, WETH from the deepest canonical WETH/USDG pool (never a look-alike) and coins through their pool at one block', async () => {
    expect(await sources.priceUsd(USDG, 5n)).toBe(1);
    expect(await sources.priceUsd(WETH, 5n)).toBeCloseTo(2000, 6);
    expect(await sources.priceUsd(coin, 5n)).toBeCloseTo(2, 6);
    expect(await sources.priceUsd(padHex('0x99', { size: 20 }), 5n)).toBeNull();
  });
  it('adds the NodeInterface L1 gas to execution gas at the block base fee, and refuses when it is unavailable', async () => {
    const tx = { chainId: 4663 as const, to: ROUTER, data: '0xabcd' as const, value: '0' };
    expect(await sources.networkFeeWei(tx, 100n, 5n)).toBe(1070n);
    vi.mocked(client.simulateContract).mockRejectedValueOnce(new Error('no NodeInterface'));
    expect(await sources.networkFeeWei(tx, 100n, 5n)).toBeNull();
  });
  it('decodes only the adapter’s single exactInputSingle multicall, with an optional unwrap', () => {
    const swap = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: coin, tokenOut: WETH, fee: 3000,
      recipient: padHex('0x02', { size: 20 }), amountIn: 5n, amountOutMinimum: 4n, sqrtPriceLimitX96: 0n }] });
    const unwrap = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [4n, coin] });
    expect(routeTerms(encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [1n, [swap, unwrap]] })))
      .toMatchObject({ tokenIn: coin, tokenOut: WETH, fee: 3000, amountIn: 5n, minOut: 4n, unwrapTo: coin });
    expect(routeTerms(encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [1n, [swap, swap]] }))).toBeNull();
    expect(routeTerms('0xdeadbeef')).toBeNull();
  });
  it('reports an unsupported binding without touching the simulation host', async () => {
    const lease = { withExclusive: vi.fn() };
    const probe = new V3ActualOrderProbe(lease, sources, () => client);
    const b = binding();
    expect(await probe.observe(b, stateFor(b), 1)).toMatchObject({ status: 'unsupported', origin: 'measured', evidenceIds: [] });
    expect(lease.withExclusive).not.toHaveBeenCalled();
  });
  it('composes the current verdict, the stored Guard assessment, the release signal and pending scans', async () => {
    const assessment = guardFixture() as GuardAssessmentV2;
    let releaseActive = false, scanPending = false;
    const queries: string[] = [];
    const sql: SqlClient = { query: async (q: string) => {
      queries.push(q);
      if (q.includes('guard_verdict_revisions')) return { rows: [{ active: releaseActive }] as never[] };
      if (q.includes('scan_jobs')) return { rows: (scanPending ? [{ pending: 1 }] : []) as never[] };
      throw new Error(`unexpected ${q}`);
    } };
    let clock = 0;
    const reads = (legacy: Verdict | null, v2: GuardAssessmentV2 | null) => ({ store: { verdict: async () => legacy }, guard: { verdict: async () => v2 } });
    expect(await readModelVerdicts(reads(legacyVerdict, null), () => sql, () => clock)(coin)).toEqual({ verdict: legacyVerdict, guardV2Active: false, scanPending: false });
    expect(await readModelVerdicts(reads(legacyVerdict, assessment), () => sql)(coin)).toMatchObject({ verdict: { ...legacyVerdict, guardV2: assessment } });
    expect(await readModelVerdicts(reads(null, null), () => sql)(coin)).toEqual({ verdict: undefined, guardV2Active: false, scanPending: false });
    expect((await readModelVerdicts(reads(null, assessment), () => sql)(coin)).verdict).toMatchObject({ level: 'pending', playbooks: [], guardV2: assessment });
    // The release signal is cached for ten seconds; a pending scan is read on every call.
    const source = readModelVerdicts(reads(legacyVerdict, null), () => sql, () => clock);
    await source(coin); releaseActive = true; scanPending = true;
    expect(await source(coin)).toMatchObject({ guardV2Active: false, scanPending: true });
    clock += 10_001;
    expect(await source(coin)).toMatchObject({ guardV2Active: true, scanPending: true });
    expect(queries.filter(q => q.includes('scan_jobs')).every(q => q.includes("phase<>'done'"))).toBe(true);
    const failing = readModelVerdicts({ store: { verdict: async () => { throw new Error('db'); } }, guard: { verdict: async () => null } }, () => sql);
    expect(await failing(coin)).toEqual({ verdict: 'unavailable', guardV2Active: false, scanPending: false });
  });
});

describe('current-verdict trade admission (no active Guard v2 release)', () => {
  const coin = padHex('0x10', { size: 20 });
  const at = (level: Verdict['level'], playbooks: Verdict['playbooks'] = []): Verdict => ({ ...legacyVerdict, level, playbooks });
  const gate = (scanPending: boolean) => currentVerdictGate(scanPending);
  const decide = (verdict: Verdict | undefined, scanPending = false, mode: 'safe' | 'balanced' | 'degen' = 'safe') => gate(scanPending)(verdict, { mode } as never, 'coin', 4663, 0).deny.map(r => r.split(':')[0]);
  const match = (id: string, level: 'danger' | 'monitor' = 'danger') => ({ id, level, confidence: 1, evidence: [] }) as Verdict['playbooks'][number];
  it('admits clear and monitor with no waiting period, refuses Danger and anything not yet scanned as retryable', () => {
    expect(decide(at('clear'))).toEqual([]);
    expect(decide(at('monitor'))).toEqual([]);
    expect(decide(at('danger'))).toEqual(['guard_danger']);
    // A Danger playbook match refuses whatever the summary level says, and is never overridable by a pending scan.
    expect(decide(at('monitor', [{ id: 'honeypot', level: 'danger', confidence: 1, evidence: [] }]))).toEqual(['guard_danger']);
    expect(decide(at('danger'), true)).toEqual(['guard_danger']);
    expect(decide(undefined)).toEqual(['scanning']);
    expect(decide(at('pending'))).toEqual(['scanning']);
    // A requested rescan supersedes the stored verdict until it finishes.
    expect(decide(at('clear'), true)).toEqual(['scanning']);
  });
  it('admits a buyer-risk Danger in Degen mode with a warning, and never a hard Danger', () => {
    const soft = at('danger', [match('run_up'), match('bundle_dump')]);
    // Careful and Balanced refuse it; Degen admits it and names what was accepted.
    expect(decide(soft, false, 'safe')).toEqual(['guard_danger']); expect(decide(soft, false, 'balanced')).toEqual(['guard_danger']);
    expect(decide(soft, false, 'degen')).toEqual([]);
    expect(gate(false)(soft, { mode: 'degen' } as never, 'coin', 4663, 0).warn).toEqual(['guard_danger_accepted: rated Danger (run_up, bundle_dump); Degen mode accepts buyer-risk findings']);
    expect(gate(false)(at('monitor'), { mode: 'degen' } as never, 'coin', 4663, 0)).toEqual({ deny: [], warn: [] });
    // A Danger level with no named match is still a buyer-risk Danger.
    expect(decide(at('danger'), false, 'degen')).toEqual([]);
    // Cannot sell, costs most of the position to sell, liquidity can be pulled, or text aimed at agents: refused in every mode.
    for (const id of ['honeypot', 'tax_trap', 'fee_trap_pool', 'malicious_hook', 'removable_liquidity', 'agent_bait']) {
      expect(decide(at('danger', [match(id), match('run_up')]), false, 'degen')).toEqual(['guard_danger']);
      // The same finding at Monitor does not refuse.
      expect(decide(at('monitor', [match(id, 'monitor')]), false, 'degen')).toEqual([]);
    }
    // Degen does not skip the scan: an unfinished one still refuses as retryable.
    expect(decide(soft, true, 'degen')).toEqual(['scanning']); expect(decide(undefined, false, 'degen')).toEqual(['scanning']);
  });
  it('lets an active Guard v2 release take precedence, and binds no verdict into sells', () => {
    const tv = (patch: Partial<TradeVerdict>): TradeVerdict => ({ verdict: at('clear'), guardV2Active: false, scanPending: false, ...patch });
    expect(buyVerdictGateFor(tv({}))).toBeTypeOf('function');
    expect(buyVerdictGateFor(tv({ guardV2Active: true }))).toBeUndefined();
    const assessment = guardFixture() as GuardAssessmentV2;
    expect(guardReceiptFor('buy', tv({ guardV2Active: true, verdict: { ...at('clear'), guardV2: assessment } }))).toBe(assessment.receipt.id);
    expect(guardReceiptFor('buy', tv({}))).toBe('current-verdict');
    for (const verdict of [at('danger'), undefined, 'unavailable' as const]) expect(guardReceiptFor('sell', tv({ verdict, guardV2Active: true }))).toBe('not-required:sell');
  });
  it('uses a recent stored sell check before probing, and refuses when neither is available', async () => {
    const rows: { status: string; checked_at: Date }[] = [];
    let cutoff: unknown;
    const db = { sql: { query: async (q: string, params: unknown[]) => {
      if (!q.includes('sell_check_latest')) return { rows: [] };
      cutoff = params[1];
      return { rows: rows.map(r => ({ coin: binary(coin), block: '7', venue: 'uniswap_v3', exit_cost_100_pct: 1, exit_cost_1k_pct: 2, ...r })) };
    } } } as unknown as ChainDb;
    const client = { getBlockNumber: vi.fn(async () => 7n), request: vi.fn(async () => { throw new Error('no probe expected'); }) };
    const guard = new SellGuard(db, client, () => 1_000_000, { probe: false });
    rows.push({ status: 'sellable', checked_at: new Date(1_000_000 - 60_000) });
    expect(await guard.check(coin, 25)).toMatchObject({ status: 'sellable', block: 7, probes: [] });
    // Only readings from the last two minutes count (SQL cutoff, in seconds).
    expect(cutoff).toBe((1_000_000 - 120_000) / 1000);
    rows[0] = { status: 'refused', checked_at: new Date(1_000_000 - 60_000) };
    expect(await guard.check(coin, 25)).toMatchObject({ status: 'refused' });
    rows.length = 0;
    await expect(guard.check(coin, 25)).rejects.toThrow(/probing is off/);
    expect(client.request).not.toHaveBeenCalled();
  });
});
