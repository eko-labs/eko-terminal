import { withRpcOrigin } from '@eko/chain';
import { formatUnits, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { loadRegistry, type MeteredForkLease } from '@eko/chain';
import { ActualOrderBindingSchema, canonicalize, type ActualOrderBinding, type ActualOrderObservation, type ActualOrderState,
  type GuardCursor, type PreflightRequest } from '@eko/shared';
import { executionPolicyHash, type Deps } from '@eko/policy';
import { ChainQuoteError, ERC20_ABI } from './v3-routes.js';
import { decodePonsFill, indexedGraduated, ponsCallTerms, ponsDepthWei, ponsOpen, ponsTradeCall, PonsHandoff, quotePonsTrade,
  readPonsCurve, PONS_FACTORY, type PonsCurveState, type PonsTradeSources } from './pons-routes.js';
import { buyVerdictGateFor, cursorOf, digest, erc20, guardReceiptFor, walletAgent, walletAgentId, walletPolicy, withAccount,
  type VerdictSource } from './live-trade.js';
import type { ActualOrderProbe } from './actual-order.js';
import type { ActualFill, PostFillEvidence, TradeReceipt, TradeReconciliationBackend } from './trade-reconcile.js';
import type { RetainedTrade, TradeBackend } from './trades.js';
import type { UniswapV3Adapter } from './chain.js';
import { isV4Binding } from './v4-trade.js';

// Live trade acquisition for native Pons v2 curves, the curve counterpart of live-trade.ts's v3 acquisition. Chain reads
// use the API's metered mainnet client at a pinned block; every account simulation runs on the same private `sim` Anvil
// lease as v3. Guard, sell check, caps, sanctions, the kill switch and policy stay in TradeService, unchanged.
const registry = loadRegistry();
const lower = (a: string) => a.toLowerCase() as Address;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const WETH = lower(registry.requireAddress('tokens.WETH'));

/**
 * Route, code and state fingerprints for one curve and side. The state fingerprint carries whether the curve is still
 * open and its fee terms, so a quote taken before graduation, or before a fee change, never matches the order-time state.
 */
export async function ponsFingerprints(client: Pick<PublicClient, 'getCode'>, s: PonsCurveState, side: 'buy' | 'sell') {
  const [coinCode, curveCode] = await Promise.all([withRpcOrigin('server.pons_trade.L30.c1',()=>client.getCode({ address: s.coin, blockNumber: s.block })), withRpcOrigin('server.pons_trade.L30.c2',()=>client.getCode({ address: s.curve, blockNumber: s.block }))]);
  return {
    routeFingerprint: digest({ venue: 'pons_curve', factory: PONS_FACTORY, curve: s.curve, coin: s.coin, side, buy: '0x59a87bc1', sell: '0xd04c6983' }),
    profileHash: digest({ coinCode: keccak256(coinCode ?? '0x'), curveCode: keccak256(curveCode ?? '0x') }),
    stateFingerprint: digest({ coin: s.coin, curve: s.curve, accountClass: 'eoa', open: ponsOpen(s), feeBps: s.feeBps, creatorTaxBps: s.creatorTaxBps }),
  };
}

/**
 * Exact-account probe for native Pons curves (the server counterpart of the chain package's PonsActualOrderProbe, on
 * the shared simulation lease). At the state's block a buy runs the exact bytes and sells the bought amount back; a
 * sell runs the exact bytes after an exact approval granted inside the simulation only. The wallet's real coin
 * allowance to the curve is reported. Provider errors are `provider_failure`; nothing here signs or broadcasts.
 */
export class PonsActualOrderProbe implements ActualOrderProbe {
  /** Wire the simulation lease, the block-bound sources and the metered chain client. No request is made here. */
  constructor(private readonly lease: MeteredForkLease, private readonly sources: PonsTradeSources, private readonly chain: () => PublicClient) {}
  /** Measure one binding at the captured state; see the class comment. */
  async observe(binding: ActualOrderBinding, state: ActualOrderState, requestClockMs: number): Promise<ActualOrderObservation> {
    const b = ActualOrderBindingSchema.parse(binding), terms = ponsCallTerms(b.tx.data);
    const result: ActualOrderObservation = { binding: b, state, quotedAtMs: requestClockMs, refreshedAtMs: requestClockMs,
      expiresAtMs: requestClockMs + 15_000, origin: 'measured', mode: b.side === 'buy' ? 'round_trip' : 'sell_only', accountClass: 'eoa',
      status: 'unsupported', spent: '0', returned: '0', tokens: '0', heldBefore: '0', allowanceBefore: '0', notionalUsd: 0,
      entryNetworkFee: '0', exitNetworkFee: '0', depthUsdLower: null, evidenceIds: [] };
    const amountIn = BigInt(b.amountIn);
    if (!terms || terms.side !== b.side || terms.amountIn !== amountIn || terms.minOut !== BigInt(b.minOut) ||
      !same(terms.recipient, b.account) || !same(b.recipient, b.account) || BigInt(b.tx.value) !== (b.side === 'buy' ? amountIn : 0n)) return result;
    const block = BigInt(state.cursor.blockNumber), curve = lower(b.tx.to);
    try {
      const indexed = await this.sources.curve(b.coin);
      if (!indexed || !same(indexed.curve, curve) || indexedGraduated(indexed, block)) return result;
      const s = await readPonsCurve(this.chain(), b.coin, curve, block).catch(error => { if (error instanceof ChainQuoteError) return null; throw error; });
      if (!s || !ponsOpen(s)) return result;
      const [fp, ethUsd] = await Promise.all([ponsFingerprints(this.chain(), s, b.side), this.sources.priceUsd(WETH, block)]);
      if (fp.routeFingerprint !== b.routeFingerprint || !ethUsd) return result;
      if (b.approval && (!same(b.approval.spender, curve) || !same(b.approval.tx.data, erc20.approve(curve, amountIn)))) return result;
      const usd = (wei: bigint) => Number(formatUnits(wei, 18)) * ethUsd;
      await withAccount(this.lease, state.cursor, b.account, async sim => {
        if (await sim.code() !== '0x') { result.accountClass = 'smart_account'; return; }
        const original = await sim.token(b.coin);
        result.heldBefore = original.toString();
        result.allowanceBefore = (await sim.allowance(b.coin, curve)).toString();
        let spent = 0n, tokens = amountIn;
        if (b.side === 'buy') {
          const before = await sim.native();
          const bought = await sim.send(curve, b.tx.data, amountIn);
          result.entryNetworkFee = bought.network.toString();
          if (!bought.ok) { result.status = 'entry_limited'; return; }
          spent = before - await sim.native() - bought.network;
          tokens = await sim.token(b.coin) - original;
          if (spent <= 0n || spent > amountIn || tokens <= 0n) throw new Error('Invalid simulated debit');
        } else if (original < amountIn) { result.status = 'entry_limited'; return; }
        // Exact approval of the quantity being sold, inside the simulation only.
        const approved = await sim.send(b.coin, erc20.approve(curve, tokens), 0n);
        if (!approved.ok) { result.status = 'exit_restricted'; return; }
        const before = await sim.native();
        const sold = await sim.send(curve, b.side === 'sell' ? b.tx.data : ponsTradeCall({ side: 'sell', amountIn: tokens, minOut: 0n, recipient: b.account }), 0n);
        result.exitNetworkFee = (approved.network + sold.network).toString();
        if (!sold.ok) { result.status = 'exit_restricted'; return; }
        const returned = await sim.native() - before + sold.network;
        if (returned <= 0n || await sim.token(b.coin) !== (b.side === 'buy' ? original : original - amountIn)) throw new Error('Invalid simulated credit');
        Object.assign(result, { spent: spent.toString(), tokens: tokens.toString(), returned: returned.toString(),
          notionalUsd: usd(b.side === 'buy' ? spent : returned), status: 'ok' });
        result.evidenceIds = [digest({ binding: b, state, receipts: sim.receipts, spent: result.spent, returned: result.returned, tokens: result.tokens })];
      });
      if (b.side === 'buy') result.depthUsdLower = usd(ponsDepthWei(s));
    } catch {
      return { ...result, status: 'provider_failure', evidenceIds: [] };
    }
    return result;
  }
}

/** Measured post-fill replay: sell the actual bought amount from the account at the fill block, on the simulation host. */
export async function ponsPostFillSell(lease: MeteredForkLease, retained: RetainedTrade, receipt: TradeReceipt, fill: ActualFill): Promise<PostFillEvidence> {
  const b = retained.checked!.order.execution!, curve = lower(b.tx.to), tokens = BigInt(fill.filledOut);
  const cursor: GuardCursor = { chainId: 4663, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash.toLowerCase() as Hex,
    transactionIndex: null, executionOrdinal: null, timestampSec: '0', boundary: 'block_end' };
  const sold = await withAccount(lease, cursor, b.account, async sim => {
    const approved = await sim.send(b.coin, erc20.approve(curve, tokens), 0n);
    if (!approved.ok) return { ok: false, receipts: sim.receipts, returned: 0n };
    const before = await sim.native();
    const out = await sim.send(curve, ponsTradeCall({ side: 'sell', amountIn: tokens, minOut: 0n, recipient: b.account }), 0n);
    const returned = out.ok ? await sim.native() - before + out.network : 0n;
    return { ok: out.ok && returned > 0n, receipts: sim.receipts, returned };
  });
  return { status: sold.ok ? 'passed' : 'failed', origin: 'measured', code: sold.ok ? 'sell_ok' : 'sell_failed', chainId: 4663,
    account: b.account, txHash: receipt.transactionHash.toLowerCase() as Hex, blockHash: receipt.blockHash.toLowerCase() as Hex,
    blockNumber: receipt.blockNumber.toString(), amount: fill.filledOut, checkedAt: new Date().toISOString(),
    evidenceIds: [digest({ replay: sold.receipts, returned: sold.returned, fill })] };
}

/**
 * Accepted acquisition for native Pons curves, as a complete TradeBackend. Quote binds the exact curve bytes to the
 * wallet, policy, Guard receipt and curve fingerprints; capture reads the wallet, curve and verdict at the chain head;
 * the probe and post-fill replay run on the simulation host; reconciliation decodes the curve's own events. A coin
 * that is not a Pons coin, or whose curve graduated, throws PonsHandoff from quote (see venueTradeBackend).
 */
export function ponsTradeBackend(o: { chain: () => PublicClient; lease: MeteredForkLease; sources: PonsTradeSources; verdict: VerdictSource;
  adapter: () => Pick<UniswapV3Adapter, 'receipt' | 'transaction'> }): TradeBackend {
  const chain = o.chain;
  const reconciliation: TradeReconciliationBackend = {
    supports: r => r.quote.route.venue === 'pons_curve' && r.quote.route.executable && Boolean(r.quote.route.poolId),
    receipt: h => o.adapter().receipt(h), transaction: h => o.adapter().transaction(h),
    decodeFill: async (r, receipt) => decodePonsFill(r, receipt),
    postFillSell: (r, receipt, fill) => ponsPostFillSell(o.lease, r, receipt, fill),
  };
  return {
    reconciliation,
    probe: new PonsActualOrderProbe(o.lease, o.sources, chain),
    /**
     * Quote the coin's open curve and bind its exact bytes; reject checked calldata that differs from the route. Return
     * a public quote without unsigned bytes. TradeService still runs current admission and policy before any bytes.
     */
    async quote(owner, input, id) {
      const route = await quotePonsTrade(chain(), input, o.sources);
      const [block, verdict, fp] = await Promise.all([chain().getBlock({ blockNumber: BigInt(route.asOfBlock) }), o.verdict(input.coin),
        ponsFingerprints(chain(), route.state, input.side)]);
      const policy = walletPolicy(input.riskMode ?? 'safe'), curve = route.state.curve;
      const approval = route.approvals.find(a => same(a.token, input.coin));
      const checked: PreflightRequest | null = input.account ? { agentId: walletAgentId(owner.id), clientOrderRef: id,
        order: { venue: 'rhc', instrument: input.coin, side: input.side, orderType: 'market', notionalUsd: input.amountUsd,
          tx: { to: route.tx.to, data: route.tx.data, value: route.tx.value },
          execution: { chainId: 4663, account: input.account, recipient: input.account, coin: input.coin, side: input.side,
            amountIn: route.amountIn, minOut: route.minOut, slippageBps: input.slippageBps, cursor: cursorOf(block), ...fp,
            policyHash: executionPolicyHash(policy), guardReceiptId: guardReceiptFor(input.side, verdict), tx: route.tx,
            approval: input.side === 'sell' && approval ? { token: input.coin, spender: curve, amount: route.amountIn, kind: 'erc20',
              tx: { chainId: 4663, to: input.coin, data: erc20.approve(curve, BigInt(route.amountIn)), value: '0' } } : null } },
        context: { reportedAt: new Date().toISOString() } } : null;
      if (checked && canonicalize(checked.order.execution?.tx) !== canonicalize(route.tx))
        throw new ChainQuoteError('quote_changed', 'Checked calldata differs from the curve route');
      const { tx: _unsigned, state: _state, costs, ...publicRoute } = route;
      // Guard and policy decisions happen in TradeService's fresh preparation, never here.
      return { checked, quote: { ...publicRoute, id, coin: input.coin, side: input.side, amountUsd: input.amountUsd,
        ...(input.account ? { account: input.account } : {}), binding: false, route: { ...route.route, executable: true },
        guard: { decision: 'allow', checks: [] }, ...costs } };
    },
    /** Read the wallet, curve, route, policy and verdict at the chain head for one retained curve quote. */
    async capture(retained) {
      const b = retained.checked!.order.execution!, curve = retained.quote.route.poolId ? lower(retained.quote.route.poolId) : null;
      if (!curve || !same(b.tx.to, curve) || !ponsCallTerms(b.tx.data)) throw new Error('Unsupported route shape');
      const head = await chain().getBlock(), at = head.number!;
      const policy = walletPolicy(retained.input.riskMode ?? 'safe');
      const s = await readPonsCurve(chain(), b.coin, curve, at);
      const [fp, native, held, allowance, indexed, verdict] = await Promise.all([
        ponsFingerprints(chain(), s, b.side),
        chain().getBalance({ address: b.account, blockNumber: at }),
        withRpcOrigin('server.pons_trade.L177',()=>chain().readContract({ address: b.coin, abi: ERC20_ABI, functionName: 'balanceOf', args: [b.account], blockNumber: at })),
        withRpcOrigin('server.pons_trade.L178',()=>chain().readContract({ address: b.coin, abi: ERC20_ABI, functionName: 'allowance', args: [b.account, curve], blockNumber: at })),
        o.sources.curve(b.coin), o.verdict(b.coin),
      ]);
      // A graduation the indexer saw first also closes the route: the fingerprint then differs from the binding.
      const open = ponsOpen(s) && !(indexed && indexedGraduated(indexed, at));
      const state: ActualOrderState = { observedAtMs: Date.now(), criticalCheckedAtMs: Date.now(), cursor: cursorOf(head), ...fp,
        stateFingerprint: open ? fp.stateFingerprint : digest({ closed: curve }),
        balanceHash: digest({ native, held, allowance }), feeHash: digest({ feeBps: s.feeBps, creatorTaxBps: s.creatorTaxBps, snipeTaxBps: s.snipeTaxBps, ekoFeeBps: 0 }),
        controlHash: fp.profileHash, sourceRevision: digest('live-trade-pons-1'), semanticHash: digest({ coin: b.coin, side: b.side }),
        policyHash: executionPolicyHash(policy), guardReceiptId: guardReceiptFor(b.side, verdict), routeAvailable: Boolean(indexed && same(indexed.curve, curve)) };
      // The same buy gate as v3: the current verdict while no Guard v2 release is active (live-trade.ts).
      const gate = buyVerdictGateFor(verdict);
      const deps: Deps = { now: Date.now, verdictFor: coin => same(coin, b.coin) ? verdict.verdict : undefined, cardFor: () => undefined,
        priceFor: () => undefined, approvalFor: () => undefined, approvalsAvailable: false, ...(gate ? { buyVerdictGate: gate } : {}),
        // Owner decision 2026-10-06: an open curve's price is deterministic, so its buy is judged by the exact measured
        // round-trip cost against the mode's ceiling instead of the ±2% depth floor. Only these exact curve bytes qualify.
        lockedLiquidityRoute: binding => open && same(binding.tx.to, curve) && ponsCallTerms(binding.tx.data) !== null };
      return { request: retained.checked!, policy, agent: walletAgent(retained.accountId, retained.wallet!), deps, state,
        admission: { status: 'allowed' }, quoteClocks: { quotedAtMs: retained.quotedAt.getTime(), expiresAtMs: retained.expiresAt.getTime() } };
    },
  };
}

const isPonsBinding = (b: ActualOrderBinding) => ponsCallTerms(b.tx.data) !== null;
type Venue = 'pons' | 'v4' | 'pools';
const venueOf = (r: RetainedTrade): Venue => r.quote.route.venue === 'pons_curve' ? 'pons' : r.quote.route.venue === 'uniswap_v4' ? 'v4' : 'pools';
/** Routes each retained order's probe to the venue its exact bytes target. */
export class VenueActualOrderProbe implements ActualOrderProbe {
  /** Wire the v3 pool, curve and (optional) v4 probes. No request is made here. */
  constructor(private readonly pools: ActualOrderProbe, private readonly pons: ActualOrderProbe, private readonly v4?: ActualOrderProbe) {}
  /** Observe with the curve probe for curve bytes, the v4 probe for v4 router bytes, otherwise the v3 pool probe. */
  observe(binding: ActualOrderBinding, state: ActualOrderState, requestClockMs: number) {
    const probe = isPonsBinding(binding) ? this.pons : this.v4 && isV4Binding(binding) ? this.v4 : this.pools;
    return probe.observe(binding, state, requestClockMs);
  }
}

/**
 * The venue hook: a coin's open Pons curve is quoted on the curve; every other coin, and a Pons coin whose curve has
 * graduated, goes to the pools (never the dead curve): its indexed v3 pools first and, when they have no route, its
 * native v4 pools (a graduated Pons coin's pool is v4). Capture, probe and reconciliation follow the venue the retained
 * quote was bound to, so an order whose curve graduated after its quote is refused by the curve acquisition's state
 * check and must be quoted again.
 * TODO(spec): BACKEND §6.1 picks the best output across venues; v3 keeps precedence so launch-day v3 routes are unchanged.
 */
export function venueTradeBackend(pools: TradeBackend, pons: TradeBackend, v4?: TradeBackend): TradeBackend {
  const backend = (venue: Venue) => venue === 'pons' ? pons : venue === 'v4' && v4 ? v4 : pools;
  const recon = (r: RetainedTrade) => backend(venueOf(r)).reconciliation;
  const reconciliation: TradeReconciliationBackend | undefined = pools.reconciliation && pons.reconciliation ? {
    supports: r => recon(r)?.supports(r) ?? false,
    receipt: h => pools.reconciliation!.receipt(h), transaction: h => pools.reconciliation!.transaction(h),
    decodeFill: (r, receipt) => recon(r)!.decodeFill(r, receipt),
    postFillSell: (r, receipt, fill) => recon(r)!.postFillSell(r, receipt, fill),
  } : undefined;
  return {
    reconciliation,
    probe: new VenueActualOrderProbe(pools.probe, pons.probe, v4?.probe),
    capture: retained => backend(venueOf(retained)).capture(retained),
    /** Quote an open Pons curve on the curve; on a PonsHandoff (no curve, or graduated) quote the v3 pools, then v4 when
     * v3 has no route. Any other curve refusal (graduating, anti-snipe, size) is final and never falls through. */
    async quote(owner, input, id) {
      try { return await pons.quote(owner, input, id); }
      catch (error) { if (!(error instanceof PonsHandoff)) throw error; }
      try { return await pools.quote(owner, input, id); }
      catch (error) {
        if (!v4 || !(error instanceof ChainQuoteError) || error.code !== 'no_route') throw error;
        try { return await v4.quote(owner, input, id); }
        catch (v4Error) { throw v4Error instanceof ChainQuoteError && v4Error.code === 'no_route' ? error : v4Error; }
      }
    },
  };
}
