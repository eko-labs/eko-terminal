import { decodeAbiParameters, encodeFunctionData, keccak256, toHex, type Address, type Hex } from 'viem';
import { ActualOrderBindingSchema, type ActualOrderBinding, type ActualOrderObservation, type ActualOrderState } from '@eko/shared';
import { ponsCall, type PonsCurveRoute } from '../simulation/pons.js';
import { referenceDigest } from '../simulation/reference.js';
import { referenceTokenAbi } from '../simulation/v3.js';
import type { PonsCurveState } from '../simulation/pons-math.js';
import type { MeteredForkLease } from '../simulation/types.js';
import { rpcStopReason } from '../rpc/metered.js';
import { CHAIN_ID } from '@eko/shared';

export interface PonsActualOrderRoute {
  route: PonsCurveRoute; curveState: PonsCurveState;
  /** Accepted profile/model evidence from 039/040, not local quote predictions or raw selectors. */
  acceptedEvidenceIds: Hex[];
  depthUsdLower: number | null;
  /** Pinned micro-USD per native raw unit with acquisition evidence. */
  quoteUsd: { numerator: string; denominator: string; evidenceIds: Hex[] };
}
const quantity = (v: unknown) => {
  if (typeof v !== 'string' || !/^0x[0-9a-f]+$/i.test(v)) throw new Error('Invalid fork quantity');
  return BigInt(v);
};
const bytes = (v: unknown): Hex => {
  if (typeof v !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(v)) throw new Error('Invalid fork bytes');
  return v as Hex;
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Actual EOA/held-position execution on an exclusive local metered fork. No balance/code/storage overrides.
 * Unsupported smart/delegated accounts remain a gap; a reference BwProbe success cannot certify them. */
export class PonsActualOrderProbe {
  /**
   * Wire exclusive metered local fork lease and trusted reviewed route resolver. Host-only
   * construction; caller authenticates account binding; no fork transaction/key signing starts yet.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  constructor(private readonly lease: MeteredForkLease,
    private readonly routeFor: (binding: ActualOrderBinding) => PonsActualOrderRoute | undefined) {}

  /**
   * Validate supplied binding/reviewed measured native route evidence and simulate exact EOA-held-
   * state buy round-trip or sell on an exclusive metered local fork, restoring/clearing
   * impersonation in finally. Trusted execution caller owns account auth; unsupported/mismatched
   * state returns explicit status, provider failure becomes provider_failure and RPC budget stops
   * rethrow. No balance/code/storage overrides or user-key signing occurs.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async observe(binding: ActualOrderBinding, state: ActualOrderState, requestClockMs: number): Promise<ActualOrderObservation> {
    const b = ActualOrderBindingSchema.parse(binding), supplied = this.routeFor(b), r = supplied?.route;
    const result: ActualOrderObservation = { binding: b, state, quotedAtMs: requestClockMs, refreshedAtMs: requestClockMs,
      expiresAtMs: requestClockMs + 15000, origin: r?.origin ?? 'fixture', mode: b.side === 'buy' ? 'round_trip' : 'sell_only',
      accountClass: 'eoa', status: 'unsupported', spent: '0', returned: '0', tokens: '0', heldBefore: '0', allowanceBefore: '0',
      notionalUsd: 0, entryNetworkFee: '0', exitNetworkFee: '0', depthUsdLower: supplied?.depthUsdLower ?? null, evidenceIds: [] };
    if (!r || !supplied || r.origin !== 'measured' || !r.verification.reviewed || !supplied.acceptedEvidenceIds.length ||
      !supplied.acceptedEvidenceIds.every(id => /^0x[0-9a-f]{64}$/i.test(id)) ||
      !same(b.account, b.recipient) || b.chainId !== CHAIN_ID || !same(r.coin, b.coin) ||
      !same(r.curve, r.spender) || b.routeFingerprint !== referenceDigest(r) ||
      b.profileHash !== r.verification.profileHash || b.stateFingerprint !== r.verification.stateFingerprint ||
      !same(state.cursor.blockHash, r.verification.blockHash) ||
      state.routeFingerprint !== b.routeFingerprint || state.profileHash !== b.profileHash || state.stateFingerprint !== b.stateFingerprint ||
      !r.feeAccounting.evidenceIds.length) return result;
    // 072's verified native layout. Verify exact reviewed bytes, never let a quote authorize an arbitrary call.
    if (r.execution.buy.selector !== '0x59a87bc1' || r.execution.sell.selector !== '0xd04c6983' ||
      [r.execution.buy, r.execution.sell].some(c => !same(c.target, r.curve) || c.words.length !== 3 ||
        c.words[0] !== 'amount' || c.words[1] !== toHex(0n, { size: 32 }) || c.words[2] !== 'recipient')) return result;
    if (!/^[1-9]\d*$/.test(supplied.quoteUsd.numerator) || !/^[1-9]\d*$/.test(supplied.quoteUsd.denominator) || !supplied.quoteUsd.evidenceIds.length || !supplied.quoteUsd.evidenceIds.every(id => /^0x[0-9a-f]{64}$/i.test(id))) return result;
    const nativeUsd = (amount: bigint) => {
      const denominator = BigInt(supplied.quoteUsd.denominator);
      // Round exposure upward at the micro-USD boundary, and refuse lossy integer conversion.
      const microUsd = (amount * BigInt(supplied.quoteUsd.numerator) + denominator - 1n) / denominator;
      return microUsd <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(microUsd) / 1000000 : 0;
    };
    result.notionalUsd = nativeUsd(BigInt(b.amountIn));
    if (b.side === 'buy' && (!Number.isFinite(result.notionalUsd) || result.notionalUsd <= 0)) return result;
    const trade = { ...r.execution[b.side], words: ['amount', toHex(BigInt(b.minOut), { size: 32 }), 'recipient'] as ('amount'|'recipient'|Hex)[] };
    if (!same(b.tx.to, r.curve) || !same(b.tx.data, ponsCall(trade, b.recipient, BigInt(b.amountIn))) ||
      b.tx.value !== (b.side === 'buy' ? b.amountIn : '0')) return result;
    const approvalData = (amount: bigint) => encodeFunctionData({ abi: referenceTokenAbi, functionName: 'approve', args: [r.spender, amount] });
    if (b.approval && (!same(b.approval.spender, r.spender) || !same(b.approval.tx.data, approvalData(BigInt(b.amountIn))))) return result;
    const traces: unknown[] = [];
    try {
      await this.lease.withExclusive(async (rpc, reset) => {
        await reset(state.cursor);
        try {
          const header = await rpc.request({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(state.cursor.blockNumber)), false] }) as { hash?: string; timestamp?: string };
          if (!header?.hash || !same(header.hash, state.cursor.blockHash) || quantity(header.timestamp) !== BigInt(state.cursor.timestampSec) ||
            quantity(await rpc.request({ method: 'eth_chainId', params: [] })) !== BigInt(CHAIN_ID)) throw new Error('Fork pin mismatch');
          for (const pin of r.verification.pins) {
            if (keccak256(bytes(await rpc.request({ method: 'eth_getCode', params: [pin.address, 'latest'] }))) !== pin.codeHash) throw new Error('Fork code mismatch');
          }
          if (![r.coin, r.curve].every(a => r.verification.pins.some(p => same(p.address, a)))) throw new Error('Code pins missing');
          for (const [key, call] of Object.entries(r.stateReads)) {
            const observed = decodeAbiParameters([{ type: 'uint256' }], bytes(await rpc.request({ method: 'eth_call', params: [{ from: b.account, to: call.target, data: ponsCall(call, b.account, 0n) }, 'latest'] })))[0];
            if (observed !== supplied.curveState[key as keyof PonsCurveState]) throw new Error('Fork curve state mismatch');
          }
          traces.push({ curveState: Object.fromEntries(Object.entries(supplied.curveState).map(([k,v]) => [k,v.toString()])) });
          if (bytes(await rpc.request({ method: 'eth_getCode', params: [b.account, 'latest'] })) !== '0x') return;
          const callUint = async (data: Hex) => decodeAbiParameters([{ type: 'uint256' }], bytes(await rpc.request({ method: 'eth_call', params: [{ from: b.account, to: b.coin, data }, 'latest'] })))[0];
          const held = () => callUint(encodeFunctionData({ abi: referenceTokenAbi, functionName: 'balanceOf', args: [b.account] }));
          const allowance = () => callUint(encodeFunctionData({ abi: referenceTokenAbi, functionName: 'allowance', args: [b.account, r.spender] }));
          const native = () => rpc.request({ method: 'eth_getBalance', params: [b.account, 'latest'] }).then(quantity);
          const original = await held(); result.heldBefore = original.toString(); result.allowanceBefore = (await allowance()).toString();
          if (b.side === 'sell' && original < BigInt(b.amountIn)) { result.status = 'entry_limited'; return; }
          await rpc.request({ method: 'anvil_impersonateAccount', params: [b.account] });
          const send = async (to: Address, data: Hex, value: string) => {
            const hash = bytes(await rpc.request({ method: 'eth_sendTransaction', params: [{ from: b.account, to, data, value: toHex(BigInt(value)), gas: toHex(30_000_000n) }] }));
            const receipt = await rpc.request({ method: 'eth_getTransactionReceipt', params: [hash] }) as { status: string; gasUsed: string; effectiveGasPrice: string; l1Fee?: string };
            const frame = await rpc.request({ method: 'debug_traceTransaction', params: [hash, { tracer: 'callTracer', tracerConfig: { withLog: true } }] });
            if (!receipt) throw new Error('Fork receipt unavailable');
            const execution = quantity(receipt.gasUsed) * quantity(receipt.effectiveGasPrice);
            if (!r.feeAccounting.gasIncludesL1 && receipt.l1Fee === undefined) throw new Error('L1 fee unavailable');
            const network = execution + (r.feeAccounting.gasIncludesL1 ? 0n : quantity(receipt.l1Fee));
            traces.push({ hash, receipt, frame });
            return { ok: quantity(receipt.status) === 1n, network };
          };
          let tokens = BigInt(b.amountIn);
          if (b.side === 'buy') {
            const before = await native(), bought = await send(b.tx.to, b.tx.data, b.tx.value);
            result.entryNetworkFee = bought.network.toString();
            if (!bought.ok) { result.status = 'entry_limited'; return; }
            const spent = before - await native() - bought.network;
            tokens = await held() - original;
            if (spent <= 0n || spent > BigInt(b.amountIn) || tokens <= 0n) throw new Error('Invalid actual debit');
            result.spent = spent.toString();
          }
          result.tokens = tokens.toString();
          // Acquire/approve exactly the new quantity; held-position mode never purchases tokens.
          const approved = await send(b.coin, approvalData(tokens), '0');
          result.exitNetworkFee = approved.network.toString();
          if (!approved.ok || await allowance() !== tokens) { result.status = 'exit_restricted'; return; }
          const before = await native();
          const sell = b.side === 'sell' ? b.tx.data : ponsCall(r.execution.sell, b.recipient, tokens);
          const sold = await send(r.curve, sell, '0');
          result.exitNetworkFee = (approved.network + sold.network).toString();
          if (!sold.ok) { result.status = 'exit_restricted'; return; }
          const returned = await native() - before + sold.network;
          if (returned <= 0n || await held() !== (b.side === 'buy' ? original : original - tokens)) throw new Error('Invalid recipient delta');
          const output = b.side === 'buy' ? tokens : returned;
          if (BigInt(b.minOut) < output * BigInt(10000 - b.slippageBps) / 10000n ||
            (b.side === 'buy' ? BigInt(result.spent) * BigInt(b.minOut) > BigInt(b.amountIn) * tokens : returned < BigInt(b.minOut))) throw new Error('Actual slippage mismatch');
          result.returned = returned.toString();
          if (b.side === 'sell') result.notionalUsd = nativeUsd(returned);
          result.status = 'ok';
          result.evidenceIds = [...supplied.acceptedEvidenceIds, ...supplied.quoteUsd.evidenceIds, referenceDigest({ binding: b, state, traces, spent: result.spent, returned: result.returned, tokens: result.tokens })];
        } finally {
          await rpc.request({ method: 'anvil_stopImpersonatingAccount', params: [b.account] });
          await reset(state.cursor);
        }
      });
    } catch (error) {
      if (rpcStopReason(error)) throw error;
      result.status = 'provider_failure'; result.evidenceIds = [];
    }
    return result;
  }
}
