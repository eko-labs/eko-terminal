import { withRpcOrigin } from '@eko/chain';
import { encodeFunctionData, formatUnits, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { loadRegistry, v4PoolId, type MeteredForkLease } from '@eko/chain';
import { ActualOrderBindingSchema, canonicalize, type ActualOrderBinding, type ActualOrderObservation, type ActualOrderState,
  type GuardCursor, type PreflightRequest } from '@eko/shared';
import { executionPolicyHash, type Deps } from '@eko/policy';
import { ChainQuoteError, ERC20_ABI } from './v3-routes.js';
import { decodeV4Fill, PERMIT2, PERMIT2_ABI, PERMIT2_TTL_SEC, quoteV4Trade, readV4Pool, v4Allowances, v4CallTerms, v4DepthWei, V4_MANAGER, V4_ROUTER,
  v4TradeCall, v4Wired, type IndexedV4Pool, type V4CallTerms, type V4TradeSources } from './v4-routes.js';
import { buyVerdictGateFor, cursorOf, digest, erc20, guardReceiptFor, walletAgent, walletAgentId, walletPolicy, withAccount,
  type VerdictSource } from './live-trade.js';
import type { ActualOrderProbe } from './actual-order.js';
import type { ActualFill, PostFillEvidence, TradeReceipt, TradeReconciliationBackend } from './trade-reconcile.js';
import type { RetainedTrade, TradeBackend } from './trades.js';
import type { UniswapV3Adapter } from './chain.js';
import { ponsGraduationLock } from './pons-graduation.js';

// Live trade acquisition for native Uniswap v4 pools, the v4 counterpart of live-trade.ts's v3 acquisition. Chain reads
// use the API's metered mainnet client at a pinned block; every account simulation runs on the same private `sim` Anvil
// lease as v3. Guard, sell check, caps, sanctions, the kill switch and policy (depth floors included) stay in TradeService.
const registry = loadRegistry();
const lower = (a: string) => a.toLowerCase() as Address;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const WETH = lower(registry.requireAddress('tokens.WETH'));
const permit2Approve = (coin: Address, amount: bigint, expiration: number) =>
  encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [coin, V4_ROUTER, amount, expiration] });
const FAR_DEADLINE = 2n ** 48n;

/**
 * Route, code and state fingerprints for one v4 pool and side; stable across blocks unless code or route changes. The
 * state fingerprint carries whether the pool is a proven-locked Pons graduation pool, so that status cannot change
 * between quote and order unnoticed.
 */
export async function v4Fingerprints(client: Pick<PublicClient, 'getCode'>, coin: Address, pool: IndexedV4Pool, side: 'buy' | 'sell', block: bigint, locked = false) {
  const [coinCode, hookCode] = await Promise.all([withRpcOrigin('server.v4_trade.L34',()=>client.getCode({ address: coin, blockNumber: block })),
    same(pool.key.hooks, zeroAddress) ? Promise.resolve('0x' as Hex) : withRpcOrigin('server.v4_trade.L35',()=>client.getCode({ address: pool.key.hooks, blockNumber: block }))]);
  return {
    routeFingerprint: digest({ venue: 'uniswap_v4', poolId: pool.id, key: pool.key, router: V4_ROUTER, permit2: PERMIT2, manager: V4_MANAGER, side }),
    profileHash: digest({ coinCode: keccak256(coinCode ?? '0x'), hookCode: keccak256(hookCode ?? '0x') }),
    stateFingerprint: digest({ coin, poolId: pool.id, manager: V4_MANAGER, accountClass: 'eoa', lockedGraduation: locked }),
  };
}
/** The binding's exact router bytes, checked against the coin, side, amounts and recipient. */
function bindingTerms(b: ActualOrderBinding): V4CallTerms | null {
  const t = v4CallTerms(b.tx.data);
  return t && same(b.tx.to, V4_ROUTER) && t.side === b.side && same(t.key.currency1, b.coin) && t.amountIn === BigInt(b.amountIn) &&
    t.minOut === BigInt(b.minOut) && same(b.recipient, b.account) && (t.side === 'buy' || same(t.recipient, b.account)) &&
    BigInt(b.tx.value) === (t.side === 'buy' ? t.amountIn : 0n) ? t : null;
}

/**
 * Exact-account probe for native v4 pools. At the state's block a buy runs the exact bytes and sells the bought amount
 * back; a sell runs the exact bytes. The Permit2 approvals a sell needs (ERC-20 to Permit2, Permit2 to the router) are
 * granted exactly inside the simulation only, and the wallet's real usable allowance is reported. Provider errors are
 * `provider_failure`; nothing here signs or broadcasts.
 */
export class V4ActualOrderProbe implements ActualOrderProbe {
  /** Wire the simulation lease, the block-bound sources and the metered chain client. No request is made here. */
  constructor(private readonly lease: MeteredForkLease, private readonly sources: V4TradeSources, private readonly chain: () => PublicClient) {}
  /** Measure one binding at the captured state; see the class comment. */
  async observe(binding: ActualOrderBinding, state: ActualOrderState, requestClockMs: number): Promise<ActualOrderObservation> {
    const b = ActualOrderBindingSchema.parse(binding), terms = bindingTerms(b);
    const result: ActualOrderObservation = { binding: b, state, quotedAtMs: requestClockMs, refreshedAtMs: requestClockMs,
      expiresAtMs: requestClockMs + 15_000, origin: 'measured', mode: b.side === 'buy' ? 'round_trip' : 'sell_only', accountClass: 'eoa',
      status: 'unsupported', spent: '0', returned: '0', tokens: '0', heldBefore: '0', allowanceBefore: '0', notionalUsd: 0,
      entryNetworkFee: '0', exitNetworkFee: '0', depthUsdLower: null, evidenceIds: [] };
    if (!terms) return result;
    const block = BigInt(state.cursor.blockNumber), amountIn = BigInt(b.amountIn), nowSec = Math.floor(requestClockMs / 1000);
    try {
      const pool = (await this.sources.pools(b.coin, block)).find(p => same(p.id, v4PoolId(terms.key)));
      if (!pool) return result;
      const [s, fp, ethUsd, allowances] = await Promise.all([readV4Pool(this.chain(), pool.id, block), v4Fingerprints(this.chain(), b.coin, pool, b.side, block),
        this.sources.priceUsd(WETH, block), v4Allowances(this.chain(), b.coin, b.account, block, nowSec)]);
      if (s.sqrtPriceX96 === 0n || fp.routeFingerprint !== b.routeFingerprint || !ethUsd) return result;
      result.allowanceBefore = allowances.usable.toString();
      const usd = (wei: bigint) => Number(formatUnits(wei, 18)) * ethUsd;
      const depth = b.side === 'buy' ? v4DepthWei(this.chain(), pool, s, block).catch(() => null) : Promise.resolve(null);
      await withAccount(this.lease, state.cursor, b.account, async sim => {
        if (await sim.code() !== '0x') { result.accountClass = 'smart_account'; return; }
        const original = await sim.token(b.coin);
        result.heldBefore = original.toString();
        let spent = 0n, tokens = amountIn;
        if (b.side === 'buy') {
          const before = await sim.native();
          const bought = await sim.send(V4_ROUTER, b.tx.data, amountIn);
          result.entryNetworkFee = bought.network.toString();
          if (!bought.ok) { result.status = 'entry_limited'; return; }
          spent = before - await sim.native() - bought.network;
          tokens = await sim.token(b.coin) - original;
          if (spent <= 0n || spent > amountIn || tokens <= 0n) throw new Error('Invalid simulated debit');
        } else if (original < amountIn) { result.status = 'entry_limited'; return; }
        // Exact Permit2 approvals for the quantity being sold, inside the simulation only.
        const toPermit2 = await sim.send(b.coin, erc20.approve(PERMIT2, tokens), 0n);
        const toRouter = toPermit2.ok ? await sim.send(PERMIT2, permit2Approve(b.coin, tokens, Math.max(nowSec, Number(state.cursor.timestampSec)) + PERMIT2_TTL_SEC), 0n) : toPermit2;
        if (!toPermit2.ok || !toRouter.ok) { result.status = 'exit_restricted'; return; }
        const before = await sim.native();
        const sold = await sim.send(V4_ROUTER, b.side === 'sell' ? b.tx.data
          : v4TradeCall({ side: 'sell', key: terms.key, amountIn: tokens, minOut: 1n, recipient: b.account, deadline: FAR_DEADLINE }), 0n);
        result.exitNetworkFee = (toPermit2.network + toRouter.network + sold.network).toString();
        if (!sold.ok) { result.status = 'exit_restricted'; return; }
        const returned = await sim.native() - before + sold.network;
        if (returned <= 0n || await sim.token(b.coin) !== (b.side === 'buy' ? original : original - amountIn)) throw new Error('Invalid simulated credit');
        Object.assign(result, { spent: spent.toString(), tokens: tokens.toString(), returned: returned.toString(),
          notionalUsd: usd(b.side === 'buy' ? spent : returned), status: 'ok' });
        result.evidenceIds = [digest({ binding: b, state, receipts: sim.receipts, spent: result.spent, returned: result.returned, tokens: result.tokens })];
      });
      const depthWei = await depth;
      if (depthWei !== null) result.depthUsdLower = usd(depthWei);
    } catch {
      return { ...result, status: 'provider_failure', evidenceIds: [] };
    }
    return result;
  }
}

/** Measured post-fill replay: sell the actual bought amount from the account at the fill block, on the simulation host. */
export async function v4PostFillSell(lease: MeteredForkLease, retained: RetainedTrade, receipt: TradeReceipt, fill: ActualFill): Promise<PostFillEvidence> {
  const b = retained.checked!.order.execution!, terms = v4CallTerms(b.tx.data), tokens = BigInt(fill.filledOut);
  if (!terms) throw new Error('Unsupported route shape');
  const cursor: GuardCursor = { chainId: 4663, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash.toLowerCase() as Hex,
    transactionIndex: null, executionOrdinal: null, timestampSec: '0', boundary: 'block_end' };
  const sold = await withAccount(lease, cursor, b.account, async sim => {
    const toPermit2 = await sim.send(b.coin, erc20.approve(PERMIT2, tokens), 0n);
    const toRouter = toPermit2.ok ? await sim.send(PERMIT2, permit2Approve(b.coin, tokens, Math.floor(Date.now() / 1000) + PERMIT2_TTL_SEC), 0n) : toPermit2;
    if (!toRouter.ok) return { ok: false, receipts: sim.receipts, returned: 0n };
    const before = await sim.native();
    const out = await sim.send(V4_ROUTER, v4TradeCall({ side: 'sell', key: terms.key, amountIn: tokens, minOut: 1n, recipient: b.account, deadline: FAR_DEADLINE }), 0n);
    const returned = out.ok ? await sim.native() - before + out.network : 0n;
    return { ok: out.ok && returned > 0n, receipts: sim.receipts, returned };
  });
  return { status: sold.ok ? 'passed' : 'failed', origin: 'measured', code: sold.ok ? 'sell_ok' : 'sell_failed', chainId: 4663,
    account: b.account, txHash: receipt.transactionHash.toLowerCase() as Hex, blockHash: receipt.blockHash.toLowerCase() as Hex,
    blockNumber: receipt.blockNumber.toString(), amount: fill.filledOut, checkedAt: new Date().toISOString(),
    evidenceIds: [digest({ replay: sold.receipts, returned: sold.returned, fill })] };
}

/**
 * Accepted acquisition for native v4 pools, as a complete TradeBackend. Quote binds the exact router bytes to the wallet,
 * policy, Guard reference and pool fingerprints (the Permit2 approvals are listed on the quote; the single-ERC-20
 * binding cannot carry them, so the order-time usable allowance gates instead); capture reads the wallet, pool, wiring
 * and verdict at the chain head; the probe and post-fill replay run on the simulation host; reconciliation decodes the
 * PoolManager Swap and the wallet's transfers. Depth floors apply as for v3.
 */
export function v4TradeBackend(o: { chain: () => PublicClient; lease: MeteredForkLease; sources: V4TradeSources; verdict: VerdictSource;
  adapter: () => Pick<UniswapV3Adapter, 'receipt' | 'transaction'> }): TradeBackend {
  const chain = o.chain;
  /** The pool is the coin's Pons graduation pool and its position is provably locked at the block. */
  const graduationLock = async (coin: Address, pool: IndexedV4Pool, block: bigint) =>
    (await ponsGraduationLock(chain(), coin, pool, o.sources.graduation ? await o.sources.graduation(coin) : null, block)).locked;
  const reconciliation: TradeReconciliationBackend = {
    supports: r => r.quote.route.venue === 'uniswap_v4' && r.quote.route.executable && Boolean(r.quote.route.poolId),
    receipt: h => o.adapter().receipt(h), transaction: h => o.adapter().transaction(h),
    decodeFill: async (r, receipt) => decodeV4Fill(r, receipt),
    postFillSell: (r, receipt, fill) => v4PostFillSell(o.lease, r, receipt, fill),
  };
  return {
    reconciliation,
    probe: new V4ActualOrderProbe(o.lease, o.sources, chain),
    /**
     * Quote the coin's best native v4 pool and bind its exact bytes; reject checked calldata that differs from the route.
     * Return a public quote without unsigned bytes. TradeService still runs current admission and policy before bytes.
     */
    async quote(owner, input, id) {
      const route = await quoteV4Trade(chain(), input, o.sources), coin = lower(input.coin), at = BigInt(route.asOfBlock);
      const lock = await graduationLock(coin, route.pool, at);
      const [block, verdict, fp] = await Promise.all([chain().getBlock({ blockNumber: at }), o.verdict(input.coin),
        v4Fingerprints(chain(), coin, route.pool, input.side, at, lock)]);
      const policy = walletPolicy(input.riskMode ?? 'safe');
      const checked: PreflightRequest | null = input.account ? { agentId: walletAgentId(owner.id), clientOrderRef: id,
        order: { venue: 'rhc', instrument: input.coin, side: input.side, orderType: 'market', notionalUsd: input.amountUsd,
          tx: { to: route.tx.to, data: route.tx.data, value: route.tx.value },
          execution: { chainId: 4663, account: input.account, recipient: input.account, coin: input.coin, side: input.side,
            amountIn: route.amountIn, minOut: route.minOut, slippageBps: input.slippageBps, cursor: cursorOf(block), ...fp,
            policyHash: executionPolicyHash(policy), guardReceiptId: guardReceiptFor(input.side, verdict), tx: route.tx, approval: null } },
        context: { reportedAt: new Date().toISOString() } } : null;
      if (checked && canonicalize(checked.order.execution?.tx) !== canonicalize(route.tx))
        throw new ChainQuoteError('quote_changed', 'Checked calldata differs from the v4 route');
      const { tx: _unsigned, pool: _pool, state: _state, ...publicRoute } = route;
      // Guard and policy decisions happen in TradeService's fresh preparation, never here.
      return { checked, quote: { ...publicRoute, id, coin: input.coin, side: input.side, amountUsd: input.amountUsd,
        ...(input.account ? { account: input.account } : {}), binding: false, route: { ...route.route, executable: true },
        guard: { decision: 'allow', checks: [] }, buyTaxPct: 0, sellTaxPct: 0, exitCostPct: 0 } };
    },
    /** Read the wallet, pool, wiring, policy and verdict at the chain head for one retained v4 quote. */
    async capture(retained) {
      const b = retained.checked!.order.execution!, terms = bindingTerms(b), poolId = retained.quote.route.poolId;
      if (!terms || !poolId || !same(v4PoolId(terms.key), poolId)) throw new Error('Unsupported route shape');
      const head = await chain().getBlock(), at = head.number!, now = Date.now();
      const policy = walletPolicy(retained.input.riskMode ?? 'safe');
      const pool = (await o.sources.pools(b.coin, at)).find(p => same(p.id, poolId)) ?? null;
      const locked = pool !== null && await graduationLock(b.coin, pool, at);
      const [fp, s, wired, native, held, allowances, verdict] = await Promise.all([
        v4Fingerprints(chain(), b.coin, pool ?? { id: poolId as Hex, key: terms.key }, b.side, at, locked), readV4Pool(chain(), poolId as Hex, at),
        v4Wired(chain(), at), chain().getBalance({ address: b.account, blockNumber: at }),
        withRpcOrigin('server.v4_trade.L194',()=>chain().readContract({ address: b.coin, abi: ERC20_ABI, functionName: 'balanceOf', args: [b.account], blockNumber: at })),
        v4Allowances(chain(), b.coin, b.account, at, Math.floor(now / 1000)), o.verdict(b.coin),
      ]);
      const state: ActualOrderState = { observedAtMs: now, criticalCheckedAtMs: now, cursor: cursorOf(head), ...fp,
        balanceHash: digest({ native, held, erc20: allowances.erc20, permit2: allowances.permit2 }), feeHash: digest({ lpFee: terms.key.fee, hooks: terms.key.hooks, ekoFeeBps: 0 }),
        controlHash: fp.profileHash, sourceRevision: digest('live-trade-v4-1'), semanticHash: digest({ coin: b.coin, side: b.side }),
        policyHash: executionPolicyHash(policy), guardReceiptId: guardReceiptFor(b.side, verdict),
        routeAvailable: pool !== null && wired && s.sqrtPriceX96 > 0n && s.liquidity > 0n };
      const gate = buyVerdictGateFor(verdict);
      const deps: Deps = { now: Date.now, verdictFor: coin => same(coin, b.coin) ? verdict.verdict : undefined, cardFor: () => undefined,
        priceFor: () => undefined, approvalFor: () => undefined, approvalsAvailable: false, ...(gate ? { buyVerdictGate: gate } : {}),
        // Owner direction 2026-10-06: a Pons graduation pool whose position is proven locked at this block is judged, like the
        // curve, by its exact measured round-trip cost instead of the ±2% depth floor. Every other v4 pool keeps its floor.
        lockedLiquidityRoute: binding => locked && same(binding.tx.to, V4_ROUTER) && same(binding.tx.data, b.tx.data) };
      return { request: retained.checked!, policy, agent: walletAgent(retained.accountId, retained.wallet!), deps, state,
        admission: { status: 'allowed' }, quoteClocks: { quotedAtMs: retained.quotedAt.getTime(), expiresAtMs: retained.expiresAt.getTime() } };
    },
  };
}
/** True for the exact v4 router bytes this backend builds. */
export const isV4Binding = (b: ActualOrderBinding) => same(b.tx.to, V4_ROUTER) && v4CallTerms(b.tx.data) !== null;
