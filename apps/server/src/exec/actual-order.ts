import { ActualOrderBindingSchema, type ActualOrderBinding, type ActualOrderLookup, type ActualOrderObservation,
  type ActualOrderState, type Agent, type Policy, type PreflightRequest, type UnsignedTx } from '@eko/shared';
import { actualBindingHash, actualStateHash, evaluate, orderHash, QUOTE_MAX_AGE_MS, QUOTE_REFRESH_MS,
  type Deps } from '@eko/policy';
import type { Address, Hex } from 'viem';

export interface CapturedExecution {
  request: PreflightRequest; policy: Policy; agent: Agent; deps: Deps;
  state: ActualOrderState;
  /** Current flags, access/caps and sanctions result from the existing order-admission checks. */
  admission: { status: 'allowed' } | { status: 'denied'; code: string };
  /** Original clocks from the trusted retained quote, never clocks accepted from the order caller. */
  quoteClocks: { quotedAtMs: number; expiresAtMs: number };
}
export interface ActualAccountRevalidationInput {
  requestClockMs: number; quotedAtMs: number; expiresAtMs: number; cursor: ActualOrderBinding['cursor'];
  account: Address; recipient: Address; coin: Address; side: 'buy'|'sell'; amountIn: string; minOut: string; slippageBps: number;
  routeFingerprint: Hex; profileHash: Hex; stateFingerprint: Hex;
  unsigned: { tx: UnsignedTx; refundRecipient: Address|null; approval: ActualOrderBinding['approval'] };
  orderHash: Hex; policyHash: Hex; guardReceiptId: Hex;
}
/** A measured buy round trip at the order's size (raw input spent and native returned), when the simulation completed. */
export interface MeasuredRoundTrip { spent: string; returned: string }
export type ActualPreparation = { status: 'unavailable'; code: string; reasons?: string[]; roundTrip?: MeasuredRoundTrip } |
  { status: 'validated'; orderHash: Hex; evidenceIds: Hex[]; roundTrip?: MeasuredRoundTrip };
export interface ActualOrderProbe {
  observe(binding: ActualOrderBinding, state: ActualOrderState, requestClockMs: number): Promise<ActualOrderObservation>;
}

/** Opt-in orchestration; no route registration, signing, executor attestation or trading activation.
 * A trusted capture reads current policy/account/Guard/state; HTTP/MCP input cannot supply evidence. */
export class ActualOrderService {
  private invalidationRevision = 0;
  private readonly cache = new Map<string, ActualOrderObservation>();
  private readonly pending = new Map<string, Promise<void>>();
  // TODO(spec): the authenticated production quote/state acquisition registry is not specified here;
  // the host must bind capture to one authenticated agent and retain the original quote clocks.
  /**
   * Retain trusted authenticated capture/probe/clock and require capacity 1-10000. Host-only wiring;
   * invalid capacity throws; caller must bind capture to the authenticated agent and no probe starts
   * yet.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  constructor(private readonly capture: (binding: ActualOrderBinding) => Promise<CapturedExecution>,
    private readonly probe?: ActualOrderProbe, private readonly now: () => number = Date.now,
    private readonly capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) throw new Error('Invalid actual quote capacity');
  }
  private key(b: ActualOrderBinding, state: ActualOrderState) { return `${actualBindingHash(b)}:${actualStateHash(state)}`; }
  private put(key: string, q: ActualOrderObservation) {
    this.cache.delete(key);
    while (this.cache.size >= this.capacity) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, structuredClone(q));
  }
  /** Cache misses queue bounded isolated work and return immediately with a named denial.
   * @remarks
   * Validate binding and return a fresh cached observation or queue bounded cloned probe work.
   * Trusted callers supply state and clock; no HTTP auth occurs. Invalid binding throws; absent
   * probe/full queue returns unavailable, acquisition errors are swallowed and never fill the cache.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  lookup(binding: ActualOrderBinding, state: ActualOrderState, requestClockMs: number): ActualOrderLookup {
    const b = ActualOrderBindingSchema.parse(binding), key = this.key(b, state), q = this.cache.get(key);
    if (q && requestClockMs >= q.quotedAtMs && requestClockMs - q.quotedAtMs <= QUOTE_MAX_AGE_MS &&
      requestClockMs <= q.expiresAtMs && requestClockMs >= q.refreshedAtMs && requestClockMs - q.refreshedAtMs <= QUOTE_REFRESH_MS)
      return { status: 'ready', observation: structuredClone(q) };
    if (!this.probe) return { status: 'unavailable', code: 'actual_account_probe_unavailable' };
    if (!this.pending.has(key)) {
      if (this.pending.size >= this.capacity) return { status: 'unavailable', code: 'actual_account_queue_full' };
      // Clone inputs before handing them to an async worker. Provider error details never enter a response.
      const revision = this.invalidationRevision, snapshotBinding = structuredClone(b), snapshotState = structuredClone(state);
      const work = Promise.resolve().then(async () => {
        const observation = await this.probe!.observe(snapshotBinding, snapshotState, requestClockMs);
        if (actualBindingHash(observation.binding) !== actualBindingHash(b) || actualStateHash(observation.state) !== actualStateHash(snapshotState)) return;
        if (revision === this.invalidationRevision) this.put(key, observation);
      }).catch(() => {}).finally(() => { this.pending.delete(key); });
      this.pending.set(key, work);
    }
    return { status: 'queued', code: q ? 'actual_account_refresh_queued' : 'actual_account_quote_queued' };
  }
  /** A separate execution decision; never resolveRepeat or a stored final allow.
   * @remarks
   * Require a structural execution binding, then acquire fresh observations and recapture current
   * trusted policy/account/state/admission before evaluation. Caller authenticates the agent via
   * capture. Missing/stale/mismatched evidence or acquisition/evaluation failure returns
   * unavailable; no bytes are signed or submitted.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async prepare(request: PreflightRequest, clocks: { quotedAtMs: number; expiresAtMs: number }): Promise<ActualPreparation> {
    const parsed = ActualOrderBindingSchema.safeParse(request.order.execution);
    if (!parsed.success) return { status: 'unavailable', code: 'actual_order_binding_missing' };
    return this.prepareBinding(parsed.data, clocks, orderHash(request.order), request);
  }
  /** Structural implementation of 072's narrow handoff; no dependency on its pending files.
   * @remarks
   * Reject stale/future request clocks and wrong refund identity, rebuild the execution binding and
   * run fresh preparation against current trusted capture. Caller authenticates account/agent in
   * capture. Binding/admission/state/probe/policy failures return unavailable; successful output is
   * evidence ids and order hash, not signing authority.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async revalidate(input: ActualAccountRevalidationInput): Promise<ActualPreparation> {
    const requestClockMs = this.now();
    if (!Number.isSafeInteger(input.requestClockMs) || input.requestClockMs > requestClockMs ||
      requestClockMs - input.requestClockMs > QUOTE_REFRESH_MS ||
      input.unsigned.refundRecipient !== (input.side === 'buy' ? input.account : null))
      return { status: 'unavailable', code: 'execution_request_stale' };
    const parsed = ActualOrderBindingSchema.safeParse({ chainId: input.unsigned.tx.chainId,
      account: input.account, recipient: input.recipient, coin: input.coin, side: input.side,
      amountIn: input.amountIn, minOut: input.minOut, slippageBps: input.slippageBps, cursor: input.cursor,
      routeFingerprint: input.routeFingerprint, profileHash: input.profileHash, stateFingerprint: input.stateFingerprint,
      policyHash: input.policyHash, guardReceiptId: input.guardReceiptId, tx: input.unsigned.tx, approval: input.unsigned.approval });
    if (!parsed.success) return { status: 'unavailable', code: 'actual_order_binding_mismatch' };
    return this.prepareBinding(parsed.data, input, input.orderHash);
  }
  private async prepareBinding(b: ActualOrderBinding, clocks: { quotedAtMs: number; expiresAtMs: number },
    expectedHash: Hex, identity?: Pick<PreflightRequest, 'agentId' | 'clientOrderRef'>): Promise<ActualPreparation> {
    const requestClockMs = this.now();
    if (![clocks.quotedAtMs, clocks.expiresAtMs].every(Number.isSafeInteger) || clocks.quotedAtMs > requestClockMs ||
      requestClockMs - clocks.quotedAtMs > QUOTE_MAX_AGE_MS || requestClockMs > clocks.expiresAtMs ||
      clocks.expiresAtMs > clocks.quotedAtMs + QUOTE_MAX_AGE_MS) return { status: 'unavailable', code: 'quote_expired' };
    if (!this.probe) return { status: 'unavailable', code: 'actual_account_probe_unavailable' };
    try {
      const before = await this.capture(b);
      if (clocks.quotedAtMs !== before.quoteClocks.quotedAtMs || clocks.expiresAtMs !== before.quoteClocks.expiresAtMs)
        return { status: 'unavailable', code: 'quote_clock_mismatch' };
      if (before.admission?.status !== 'allowed') return { status: 'unavailable', code: before.admission?.status === 'denied' ? before.admission.code : 'execution_access_unavailable' };
      if (identity && (identity.agentId !== before.request.agentId || identity.clientOrderRef !== before.request.clientOrderRef))
        return { status: 'unavailable', code: 'order_mismatch' };
      if (orderHash(before.request.order) !== expectedHash) return { status: 'unavailable', code: 'order_mismatch' };
      const observed = await this.probe.observe(structuredClone(b), structuredClone(before.state), requestClockMs);
      // Acquisition may take time or race a fee/control/balance/route/policy update. Capture again before bytes leave.
      const current = await this.capture(b), finishedAtMs = this.now();
      if (current.request.agentId !== before.request.agentId || current.request.clientOrderRef !== before.request.clientOrderRef || current.quoteClocks.quotedAtMs !== before.quoteClocks.quotedAtMs || current.quoteClocks.expiresAtMs !== before.quoteClocks.expiresAtMs || orderHash(current.request.order) !== expectedHash || actualStateHash(before.state) !== actualStateHash(current.state))
        return { status: 'unavailable', code: 'actual_order_state_changed' };
      if (current.admission?.status !== 'allowed') return { status: 'unavailable', code: current.admission?.status === 'denied' ? current.admission.code : 'execution_access_unavailable' };
      if (finishedAtMs > clocks.expiresAtMs || finishedAtMs - clocks.quotedAtMs > QUOTE_MAX_AGE_MS)
        return { status: 'unavailable', code: 'quote_expired' };
      const result = evaluate(current.request, current.policy, current.agent, { ...current.deps, guardPolicyV2: true,
        now: () => finishedAtMs, actualStateFor: () => current.state, actualOrderFor: () => ({ status: 'ready', observation: observed }) });
      // The measured round trip the buy was judged on, so the quote can show its exit cost before anything is signed.
      const roundTrip = observed.status === 'ok' && observed.mode === 'round_trip' && BigInt(observed.spent) > 0n
        ? { roundTrip: { spent: observed.spent, returned: observed.returned } } : {};
      if (result.decision !== 'allow') return { status: 'unavailable', code: result.reasons[0]?.split(':')[0] ?? 'execution_denied', reasons: result.reasons, ...roundTrip };
      // A sell spends the coin; a buy with no native value spends a token. Either needs the wallet's exact allowance,
      // which the probe reports in `allowanceBefore` for the token being spent.
      if ((b.side === 'sell' || BigInt(b.tx.value) === 0n) && BigInt(observed.allowanceBefore) < BigInt(b.amountIn))
        return { status: 'unavailable', code: 'token_approval_required', ...roundTrip };
      return { status: 'validated', orderHash: expectedHash, evidenceIds: [...observed.evidenceIds], ...roundTrip };
    } catch {
      return { status: 'unavailable', code: 'execution_revalidation_unavailable' };
    }
  }
  /** Immediate invalidation is supplementary: state fingerprints also prevent stale cache hits.
   * @remarks
   * Advance the invalidation revision and remove cached observations selected by the predicate;
   * prior pending work cannot repopulate the cache. Host/trusted state-change caller only; predicate
   * failures propagate and may leave partial eviction.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  invalidate(predicate: (binding: ActualOrderBinding) => boolean) {
    this.invalidationRevision++;
    for (const [key, q] of this.cache) if (predicate(q.binding)) this.cache.delete(key);
  }
  /**
   * Await currently pending probe work. Host shutdown/test caller only; acquisition failures were
   * swallowed by lookup and produce no cached observation.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async drain(): Promise<void> { await Promise.all(this.pending.values()); }
}
