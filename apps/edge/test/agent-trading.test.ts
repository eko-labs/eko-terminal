import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { loadElysiumRegistry } from '@eko/chain';
import { AccountStore } from '../src/accounts.js';
import { AgentStore, PRESETS, type AgentRow } from '../src/agents.js';
import { HistoryStore } from '../src/history.js';
import { mcpTools } from '../src/mcp.js';
import { MSG_SENDER, Trading, universalRouterAbi, v4QuoterAbi } from '../src/trade.js';
import type { Assessment } from '../src/assess.js';
import type { CoinState } from '../src/tracker.js';
import type { Edge } from '../src/service.js';

const registry = loadElysiumRegistry();
const COIN = getAddress('0xabababababababababababababababababababab'), OTHER = getAddress('0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd');
const AGENT_WALLET = getAddress('0x00000000000000000000000000000000000a11ce'), ATTACKER = getAddress('0x00000000000000000000000000000000000ba11d');

/** Mission Control with one Balanced agent (approval above $250, $500 cap), MCP tools and a stand-in for the trading service. */
function setup(opts: { impactWarn?: boolean } = {}) {
  const store = new HistoryStore(':memory:'), agents = new AgentStore(new AccountStore(store.db).db);
  const created = agents.create('acct_x', 'Bot', 'onchain', PRESETS[1]!.policy);
  const assessment = { verdict: { coin: COIN.toLowerCase(), level: 'clear', reasons: [], playbooks: [] }, probe: { exitCostPct: 2 } } as unknown as Assessment;
  const prepared: { wallet: Address; idem: string }[] = [];
  const trading = {
    quote: async (q: { coin: Address; side: 'buy' | 'sell'; slippageBps: number }) => ({ id: `q_${prepared.length}`, coin: q.coin, side: q.side, amountIn: '1', expectedOut: '2', minOut: '1', priceImpactBps: opts.impactWarn ? 1500 : 10,
      guard: { decision: opts.impactWarn ? 'warn' : 'allow', checks: opts.impactWarn ? [{ code: 'price_impact', status: 'warn', label: 'This trade moves the price 15.0%.' }] : [] } }),
    approvalTxs: () => [],
    order: async (_acct: string, wallet: Address, body: { idempotencyKey: string }) => { prepared.push({ wallet, idem: body.idempotencyKey }); return { order: { id: `ord_${prepared.length}` }, tx: { chainId: 99901, to: zeroAddress, data: '0x', value: '0' } }; },
  } as unknown as Trading;
  const edge = { tracker: { coin: () => ({}) as CoinState }, fresh: async () => assessment } as unknown as Edge;
  const tools = new Map(mcpTools({ edge, agents, trading }).map(t => [t.name, t]));
  const agent = () => agents.byId(created.id)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are checked with toMatchObject
  const run = async (name: string, args: Record<string, unknown>, who: AgentRow = agent()): Promise<{ ok: boolean; out?: any; error?: string }> => {
    try { return { ok: true, out: await tools.get(name)!.run(args, who) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  };
  const preflight = (ref: string, coin: Address, notionalUsd: number, side = 'buy') => run('preflight', { clientOrderRef: ref, coin, side, notionalUsd });
  const prepare = (ref: string, coin: Address, amountUsd: number, extra: Record<string, unknown> = {}) => run('trade_prepare', { preflightClientOrderRef: ref, coin, side: 'buy', amountUsd, ...extra });
  return { agents, agent, run, preflight, prepare, prepared, setWallet: () => agents.setWallet(created.id, AGENT_WALLET) };
}

describe('agent trading guardrails', () => {
  it('refuses an "allow" the agent wrote into its own journal (audit: forged preflight)', async () => {
    const t = setup(); t.setWallet();
    // The journal tool no longer takes decisions or orders at all ...
    expect(await t.run('journal', { kind: 'decision', payload: { clientOrderRef: 'forged-01', decision: 'allow', order: { coin: COIN, side: 'buy', notionalUsd: 400 } } })).toMatchObject({ ok: false });
    // ... and even a decision row without EKO's own preflightId (as older journals may hold) is not trusted.
    t.agents.journal(t.agent().id, 'decision', { clientOrderRef: 'forged-01', decision: 'allow', order: { coin: COIN, side: 'buy', notionalUsd: 400 } });
    expect(await t.prepare('forged-01', COIN, 400)).toMatchObject({ ok: false, error: expect.stringMatching(/Run preflight/) });
    expect(t.prepared).toHaveLength(0);
  });

  it('binds an owner approval to the exact order and spends it on one trade (audit: approval not bound)', async () => {
    const t = setup(); t.setWallet();
    const asked = await t.preflight('order-A-0001', COIN, 300);
    expect(asked.ok && asked.out.decision).toBe('needs_approval');
    t.agents.decide('acct_x', String((asked as { out: { approvalId: string } }).out.approvalId), 'approved');
    // The same reference for another coin or size is refused, not approved.
    expect((await t.preflight('order-A-0001', OTHER, 300) as { out: { decision: string } }).out.decision).toBe('deny');
    expect((await t.preflight('order-A-0001', COIN, 450) as { out: { reasons: string[] } }).out.reasons.join(' ')).toMatch(/different order/);
    // The approved order itself is allowed and readies exactly one transaction.
    expect((await t.preflight('order-A-0001', COIN, 300) as { out: { decision: string } }).out.decision).toBe('allow');
    expect(await t.prepare('order-A-0001', COIN, 300)).toMatchObject({ ok: true, out: { status: 'ready' } });
    expect(await t.prepare('order-A-0001', COIN, 300)).toMatchObject({ ok: false, error: expect.stringMatching(/already prepared/) });
    // A fresh preflight under the used approval is denied rather than re-allowed.
    expect((await t.preflight('order-A-0001', COIN, 300) as { out: { reasons: string[] } }).out.reasons.join(' ')).toMatch(/already used/);
    expect(t.prepared).toHaveLength(1);
  });

  it('trades only from the wallet the owner set, never one the model names (audit: model-chosen recipient)', async () => {
    const t = setup();
    expect((await t.preflight('order-W-0001', COIN, 100) as { out: { decision: string } }).out.decision).toBe('allow');
    expect(await t.prepare('order-W-0001', COIN, 100, { wallet: ATTACKER })).toMatchObject({ ok: false, error: expect.stringMatching(/has not set this agent's wallet/) });
    expect(t.agent().wallet).toBeNull(); // the agent's call bound nothing
    t.setWallet();
    expect(await t.prepare('order-W-0001', COIN, 100, { wallet: ATTACKER })).toMatchObject({ ok: false, error: expect.stringMatching(/not the wallet your owner set/) });
    expect(await t.prepare('order-W-0001', COIN, 100)).toMatchObject({ ok: true, out: { status: 'ready' } });
    expect(t.prepared).toEqual([{ wallet: AGENT_WALLET, idem: 'order-W-0001' }]);
  });

  it('caps an agent\'s slippage by policy and never accepts a large price move for it (audit: model-chosen slippage)', async () => {
    const t = setup(); t.setWallet();
    await t.preflight('order-S-0001', COIN, 100);
    expect(await t.prepare('order-S-0001', COIN, 100, { slippageBps: 5000 })).toMatchObject({ ok: false, error: expect.stringMatching(/Slippage over 5%/) });
    const big = setup({ impactWarn: true }); big.setWallet();
    await big.preflight('order-S-0002', COIN, 100);
    expect(await big.prepare('order-S-0002', COIN, 100)).toMatchObject({ ok: false, error: expect.stringMatching(/Agents cannot accept that/) });
    expect(big.prepared).toHaveLength(0);
  });
});

describe('the swap transaction', () => {
  it('pays the output to whoever signs (MSG_SENDER), whatever wallet the order names', async () => {
    const store = new HistoryStore(':memory:'), router = registry.address('uniswapV4.universalRouter212');
    const key = { currency0: zeroAddress, currency1: COIN, fee: 0, tickSpacing: 60, hooks: zeroAddress } as const;
    const coin = { token: COIN, manager: registry.address('uniswapV4.poolManager'), poolId: `0x${'1'.repeat(64)}`, trades: [{ priceHype: 0.001 }] } as unknown as CoinState;
    const assessment = { key, verdict: { level: 'clear', playbooks: [] }, probe: { exitCostPct: 1 }, block: 1, taxPct: null, currentBuyFeePips: null, config: null, antiSnipe: null } as unknown as Assessment;
    const rpc = { request: async ({ method, params }: { method: string; params: unknown[] }) => {
      if (method === 'eth_gasPrice') return '0x1';
      const call = params[0] as { to: string };
      if (call.to.toLowerCase() === registry.address('uniswapV4.v4Quoter').toLowerCase()) return encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', result: [10n ** 21n, 100_000n] });
      return '0x';
    } };
    const trading = new Trading({ db: store.db, rpc: rpc as never, registry, coin: () => coin, assess: async () => assessment, hypeUsd: () => 30, maxTradeUsd: 250 });
    const quote = await trading.quote({ coin: COIN, side: 'buy', amountUsd: 30, slippageBps: 300 }, AGENT_WALLET);
    const { tx } = await trading.order('acct_x', AGENT_WALLET, { quoteId: quote.id, idempotencyKey: 'k-1', acknowledged: [] });
    expect(tx.to).toBe(router);
    const { args } = decodeFunctionData({ abi: universalRouterAbi, data: tx.data as Hex });
    const [, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], args[1][0]!);
    const [, recipient] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], params[2]!);
    expect(recipient).toBe(MSG_SENDER);
  });
});
