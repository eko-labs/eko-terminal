import { encodeFunctionData, isAddress, parseAbi, toFunctionSelector, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { GuardCursorSchema, type GuardCursor, type UnsignedTx } from '@eko/shared';
import evidence from '../../abi/pons/execution.json' with { type: 'json' };
import { ponsLegs, type PonsCurveRoute } from '../simulation/pons.js';
import { ponsBuy, ponsSell, type PonsCharges, type PonsCurveState } from '../simulation/pons-math.js';
import { referenceDigest } from '../simulation/reference.js';
import { referenceTokenAbi } from '../simulation/v3.js';
import { CHAIN_ID } from '@eko/shared';

/** Deployed selectors from the supplied lead evidence; no quote getter was verified. */
export const ponsTradeAbi = parseAbi([
  'function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable',
  'function sell(uint256 tokensIn,uint256 minQuoteOut,address recipient)',
]);
export const ponsExecutableSelectors = evidence.functions;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (s: string) => /^0x[0-9a-f]{64}$/i.test(s);
const uint = (n: bigint, positive = false) => {
  if (n < (positive ? 1n : 0n) || n >= 2n ** 256n) throw new Error('Invalid Pons raw amount');
  return n;
};
const address = (a: Address) => {
  if (!isAddress(a, { strict: false }) || same(a, zeroAddress)) throw new Error('Invalid Pons address');
};

/** Attach these bindings to a reviewed 039/040 native route, never to an arbitrary curve by brand.
 * @remarks
 * Validate a nonzero curve address and attach the checked-in buy/sell selectors with static
 * amount/minimum/recipient word bindings. Public pure preparation without auth; invalid address
 * throws. This alone does not authenticate deployed curve code.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
 */
export function ponsV2Execution(curve: Address): PonsCurveRoute['execution'] {
  address(curve);
  const words: ('amount' | 'recipient' | Hex)[] = ['amount', toHex(0n, { size: 32 }), 'recipient'];
  return {
    buy: { target: curve, selector: '0x59a87bc1', words: [...words] },
    sell: { target: curve, selector: '0xd04c6983', words: [...words] },
  };
}

export interface PonsAbiPin {
  blockHash: Hex; curveCodeHash: Hex; sourceRevision: Hex; evidenceIds: Hex[];
  /** Dispatcher selectors checked in this curve's deployed code at the pin. */
  buySelector: Hex; sellSelector: Hex;
}
/**
 * Check reviewed route/address/code/evidence pins and exact selector/word bindings against
 * supplied ABI pin. Public pure validation without auth or RPC; missing/inconsistent pins return
 * false and malformed typed inputs can throw. Caller must acquire/review the underlying evidence.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
 */
export function verifiedPonsExecution(route: PonsCurveRoute, pin: PonsAbiPin | null): boolean {
  const v = route.verification;
  return !!pin && route.venue === 'pons_curve' && v.reviewed &&
    [route.coin, route.curve, route.spender].every(a => isAddress(a, { strict: false }) && !same(a, zeroAddress) &&
      v.pins.some(p => same(p.address, a) && hash(p.codeHash))) && same(route.spender, route.curve) &&
    hash(v.profileHash) && hash(v.stateFingerprint) && hash(v.sourceRevision) &&
    v.evidenceIds.length > 0 && v.evidenceIds.every(hash) && pin.evidenceIds.length > 0 && pin.evidenceIds.every(hash) &&
    same(pin.blockHash, v.blockHash) && hash(pin.blockHash) && same(pin.sourceRevision, v.sourceRevision) && hash(pin.curveCodeHash) &&
    v.pins.some(p => same(p.address, route.curve) && same(p.codeHash, pin.curveCodeHash)) &&
    pin.buySelector === '0x59a87bc1' && pin.sellSelector === '0xd04c6983' &&
    evidence.functions.every(f => toFunctionSelector(f.signature) === f.selector) &&
    referenceDigest(route.execution) === referenceDigest(ponsV2Execution(route.curve));
}

export interface PonsUnsignedTrade {
  tx: UnsignedTx;
  /** The submitting account, not the output recipient, receives any native buy refund. */
  refundRecipient: Address | null;
  approval: { token: Address; spender: Address; amount: string; kind: 'erc20'; tx: UnsignedTx } | null;
}
/** Reviewable unsigned bytes only. This does not grant permission to submit an order.
 * @remarks
 * Require supplied route/ABI pin agreement and valid account/recipient/raw units, then build
 * unsigned native buy or sell with explicit ERC20 approval. Caller authenticates account and owns
 * admission; invalid ABI/address/amount/encoding throws. Native buy refund is attributed to
 * sender; no signing/submission occurs.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
 */
export function buildPonsTrade(route: PonsCurveRoute, pin: PonsAbiPin | null, input: {
  side: 'buy' | 'sell'; account: Address; recipient: Address; amountIn: bigint; minOut: bigint;
}): PonsUnsignedTrade {
  if (!verifiedPonsExecution(route, pin)) throw new Error('Pons executable ABI unavailable');
  address(input.account); address(input.recipient); uint(input.amountIn, true); uint(input.minOut, true);
  const execution = ponsV2Execution(route.curve);
  execution[input.side].words[1] = toHex(input.minOut, { size: 32 });
  // Use the same static word/offset encoder as 040. The trade sells an explicit quantity, never a patched template.
  const legs = ponsLegs({ ...route, execution }, input.recipient, input.amountIn);
  const tx: UnsignedTx = { chainId: CHAIN_ID, to: route.curve,
    data: input.side === 'buy' ? legs.buy.data : legs.sellWithAmount(input.amountIn),
    value: input.side === 'buy' ? input.amountIn.toString() : '0' };
  return { tx, refundRecipient: input.side === 'buy' ? input.account : null,
    approval: input.side === 'buy' ? null : { token: route.coin, spender: route.curve, amount: input.amountIn.toString(), kind: 'erc20',
      tx: { chainId: CHAIN_ID, to: route.coin, value: '0', data: encodeFunctionData({ abi: referenceTokenAbi,
        functionName: 'approve', args: [route.curve, input.amountIn] }) } } };
}

export interface PonsQuoteSnapshot {
  cursor: GuardCursor; profileHash: Hex; stateFingerprint: Hex; evidenceIds: Hex[];
  quoteAsset: 'native' | 'erc20';
  /** 040 reserve reconstruction: pricing quote excludes pending fees/tax, virtual quote is separate. */
  state: PonsCurveState;
  feeBps: bigint; creatorTaxBps: bigint; currentSnipeTaxBps: bigint;
  graduated: boolean; readyToGraduate: boolean;
}

/** Fresh-key evidence contains addresses and reads only, never keys. All reads belong to task 138. */
export interface PonsForkIdentity {
  address: Address; keyOrigin: 'fresh_generated'; codeAtPinnedBlock: '0x'; evidenceIds: Hex[];
}
export interface PonsTradeForkCase {
  id: Hex; origin: 'measured' | 'fixture'; blockHash: Hex; routeFingerprint: Hex;
  sizeUsd: 100 | 1000; accountClass: 'eoa' | 'contract'; phase: 'active' | 'expired'; refundCase: boolean;
  gasPayer: PonsForkIdentity; buyRecipient: PonsForkIdentity; sellRecipient: PonsForkIdentity;
  gatewayEvidenceId: Hex; evidenceIds: Hex[];
  requestedQuote: bigint; predictedSpent: bigint; predictedTokens: bigint; predictedQuoteOut: bigint;
  buyEvent: { recipient: Address; spent: bigint; tokensOut: bigint; fee: bigint; tax: bigint };
  sellEvent: { recipient: Address; tokensIn: bigint; quoteOut: bigint; fee: bigint; tax: bigint };
  /** Measured at recipients, with no gas debit on the sell recipient. */
  tokenBalanceDelta: bigint; nativeBalanceDelta: bigint; senderRefund: bigint;
  allowanceAfterApproval: bigint; expectedBuyFee: bigint; expectedBuyTax: bigint;
  expectedSellFee: bigint; expectedSellTax: bigint;
}
export type PonsTradeForkGate =
  | { status: 'pending'; reason: 'metered_fork_evidence_missing'; cases: [] }
  | { status: 'supplied'; cases: PonsTradeForkCase[] };
/**
 * Return explicit pending metered-fork-evidence state with no cases. Public pure operation without
 * auth/failure side effects; it cannot open execution.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
 */
export const pendingPonsTradeForkGate = (): PonsTradeForkGate => ({ status: 'pending', reason: 'metered_fork_evidence_missing', cases: [] });

/** Validate supplied evidence; synthetic envelopes can test this contract but cannot accept a deployment.
 * @remarks
 * Check supplied measured case matrix, route/block/recipient/refund/fee/tax and raw balance
 * bindings and return named gaps. Caller supplies reviewed evidence; no RPC/authentication.
 * Pending returns missing evidence; malformed typed data can throw; fixtures cannot accept
 * deployment.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
 */
export function ponsTradeForkGateIssues(route: PonsCurveRoute, gate: PonsTradeForkGate): string[] {
  if (gate.status === 'pending') return ['metered_fork_evidence_missing'];
  const fingerprint = referenceDigest(route);
  const fresh = (i: PonsForkIdentity) => i.keyOrigin === 'fresh_generated' && i.codeAtPinnedBlock === '0x' &&
    isAddress(i.address, { strict: false }) && !same(i.address, zeroAddress) && i.evidenceIds.length > 0 && i.evidenceIds.every(hash);
  const valid = (c: PonsTradeForkCase) => c.origin === 'measured' && hash(c.id) && c.evidenceIds.length > 0 && c.evidenceIds.every(hash) &&
    hash(c.gatewayEvidenceId) && same(c.blockHash, route.verification.blockHash) && c.routeFingerprint === fingerprint &&
    [c.gasPayer, c.buyRecipient, c.sellRecipient].every(fresh) && !same(c.gasPayer.address, c.sellRecipient.address) &&
    same(c.buyEvent.recipient, c.buyRecipient.address) && same(c.sellEvent.recipient, c.sellRecipient.address) &&
    [c.requestedQuote, c.predictedSpent, c.predictedTokens, c.predictedQuoteOut].every(n => n > 0n && n < 2n ** 256n) &&
    c.buyEvent.spent === c.predictedSpent && c.buyEvent.tokensOut === c.predictedTokens && c.tokenBalanceDelta === c.buyEvent.tokensOut &&
    c.sellEvent.tokensIn === c.buyEvent.tokensOut && c.sellEvent.quoteOut === c.predictedQuoteOut && c.nativeBalanceDelta === c.sellEvent.quoteOut &&
    c.allowanceAfterApproval === c.sellEvent.tokensIn && c.senderRefund === c.requestedQuote - c.buyEvent.spent && c.senderRefund >= 0n &&
    c.refundCase === (c.senderRefund > 0n) &&
    [c.expectedBuyFee, c.expectedBuyTax, c.expectedSellFee, c.expectedSellTax].every(n => n >= 0n) &&
    c.buyEvent.fee === c.expectedBuyFee && c.buyEvent.tax === c.expectedBuyTax &&
    c.sellEvent.fee === c.expectedSellFee && c.sellEvent.tax === c.expectedSellTax;
  const issues: string[] = [];
  if (route.origin !== 'measured' || new Set(gate.cases.map(c => c.id)).size !== gate.cases.length || gate.cases.some(c => !valid(c))) {
    issues.push('fork_assertion_mismatch');
  }
  for (const size of [100, 1000]) for (const cls of ['eoa', 'contract']) for (const phase of ['active', 'expired']) {
    if (!gate.cases.some(c => valid(c) && c.sizeUsd === size && c.accountClass === cls && c.phase === phase && !c.refundCase)) {
      issues.push(`fork_case_missing:${size}:${cls}:${phase}`);
    }
  }
  for (const cls of ['eoa', 'contract']) if (!gate.cases.some(c => valid(c) && c.accountClass === cls && c.refundCase)) issues.push(`fork_refund_missing:${cls}`);
  return issues;
}

/** Narrow task-052 handoff. 052 owns freshness, immediate invalidation, policy and actual-account simulation. */
export interface PonsActualAccountRevalidation {
  revalidate(input: {
    requestClockMs: number; quotedAtMs: number; expiresAtMs: number; cursor: GuardCursor;
    account: Address; recipient: Address; coin: Address; side: 'buy' | 'sell'; amountIn: string; minOut: string; slippageBps: number;
    routeFingerprint: Hex; profileHash: Hex; stateFingerprint: Hex; unsigned: PonsUnsignedTrade;
    orderHash: Hex; policyHash: Hex; guardReceiptId: Hex;
  }): Promise<{ status: 'unavailable'; code: string } | { status: 'validated'; orderHash: Hex; evidenceIds: Hex[] }>;
}

export interface PonsVenueLinks { ponsCurve: string; allowedOrigins: readonly string[] }
/** Configuration owns the link. Never reflect token metadata or manufacture a token-page URL.
 * @remarks
 * Validate the operator-configured credential-free HTTPS venue link against exact allowed origins.
 * Public configuration projection without wallet auth; malformed/foreign URL throws and token
 * metadata is never used to construct it.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
 */
export function ponsVenueLink(config: PonsVenueLinks): string {
  const u = new URL(config.ponsCurve);
  if (u.protocol !== 'https:' || u.username || u.password || !config.allowedOrigins.includes(u.origin)) throw new Error('Pons venue link is not allowlisted');
  return u.href;
}
export interface PonsCurveQuote {
  amountIn: string; valueWei: string; expectedOut: string | null; minOut: string | null;
  predictedSpent: string | null; predictedRefund: string | null; charges: PonsCharges | null;
  binding: false; route: { venue: 'pons_curve'; poolId: string; executable: false; linkOut: string };
  fee: { bps: 0; usd: 0; destination: null };
  quotedAtMs: number; expiresAtMs: number; refreshAfterMs: number; unavailable: string[];
  /** For review and the future 052 input only, never an executable order response. */
  candidate: PonsUnsignedTrade | null;
}
/** Pure native Pons adapter. State acquisition stays in metered 039/040; no server keys, transport or submission. */
export class PonsCurveAdapter {
  /**
   * Validate and retain the operator-owned allowed venue link. Host-only construction;
   * invalid/foreign URL throws and no chain/state acquisition occurs.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  constructor(private readonly links: PonsVenueLinks) { ponsVenueLink(links); }
  /**
   * Validate inputs/pins/native state and modeled ordinary/creator fee schedule, then compute
   * candidate raw amounts/refunds and optional unsigned bytes. Caller owns account auth/state
   * acquisition; invalid input/fees throw, evidence/model/capacity gaps stay unavailable. Always
   * binding=false/executable=false with zero terminal fee; fork observations and future actual-
   * account revalidation remain gates.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  quote(input: {
    route: PonsCurveRoute; abiPin: PonsAbiPin | null; snapshot: PonsQuoteSnapshot; forkGate: PonsTradeForkGate;
    side: 'buy' | 'sell'; amountIn: bigint; slippageBps: number; account?: Address; recipient?: Address; quotedAtMs: number;
  }): PonsCurveQuote {
    uint(input.amountIn, true);
    if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10000 ||
      !Number.isSafeInteger(input.quotedAtMs) || input.quotedAtMs < 0) throw new Error('Invalid Pons quote input');
    if (input.account) address(input.account);
    if (input.recipient) address(input.recipient);
    const { route: r, snapshot: s } = input;
    const cursor = GuardCursorSchema.parse(s.cursor);
    const out: PonsCurveQuote = { amountIn: input.amountIn.toString(), valueWei: input.side === 'buy' ? input.amountIn.toString() : '0',
      expectedOut: null, minOut: null, predictedSpent: null, predictedRefund: null, charges: null, candidate: null, binding: false,
      route: { venue: 'pons_curve', poolId: r.id, executable: false, linkOut: ponsVenueLink(this.links) }, fee: { bps: 0, usd: 0, destination: null },
      quotedAtMs: input.quotedAtMs, expiresAtMs: input.quotedAtMs + 15000, refreshAfterMs: input.quotedAtMs + 5000,
      unavailable: [...ponsTradeForkGateIssues(r, input.forkGate), 'actual_account_revalidation_052_missing'] };
    if (!verifiedPonsExecution(r, input.abiPin)) out.unavailable.push('executable_abi_missing');
    if (cursor.chainId !== CHAIN_ID || cursor.boundary !== 'block_end' || !same(cursor.blockHash, r.verification.blockHash) ||
      s.profileHash !== r.verification.profileHash || s.stateFingerprint !== r.verification.stateFingerprint ||
      s.evidenceIds.length === 0 || !s.evidenceIds.every(hash)) { out.unavailable.push('quote_state_unverified'); return out; }
    if (s.quoteAsset !== 'native') { out.unavailable.push('quote_asset_unsupported'); return out; }
    if (s.graduated || s.readyToGraduate) { out.unavailable.push('curve_closed'); return out; }
    if ([s.feeBps, s.creatorTaxBps, s.currentSnipeTaxBps].some(n => n < 0n || n > 10000n)) throw new Error('Invalid Pons fee getter');
    // TODO(spec): deployed active-snipe application and exemptions need 138 fork evidence; never assume additive tax or a duration.
    if (s.currentSnipeTaxBps !== 0n || r.decayEndSec === null || BigInt(cursor.timestampSec) < BigInt(r.decayEndSec)) {
      out.unavailable.push('anti_snipe_model_unverified'); return out;
    }
    const terms = input.side === 'buy' ? r.buyTerms : r.sellTerms;
    if (terms.some(t => !['ordinary', 'creator'].includes(t.kind) || t.base !== 'gross' || t.fixedWei !== 0n || t.bps < 0n || t.bps > 10000n) ||
      terms.filter(t => t.kind === 'ordinary').reduce((n, t) => n + t.bps, 0n) !== s.feeBps ||
      terms.filter(t => t.kind === 'creator').reduce((n, t) => n + t.bps, 0n) !== s.creatorTaxBps) {
      out.unavailable.push('fee_schedule_unverified'); return out;
    }
    // Separate floor rounding per ordinary/creator component; split terms would change the deployed rounding.
    if (terms.filter(t => t.kind === 'ordinary').length > 1 || terms.filter(t => t.kind === 'creator').length > 1) {
      out.unavailable.push('fee_schedule_unverified'); return out;
    }
    const q = input.side === 'buy' ? ponsBuy(s.state, input.amountIn, terms) : ponsSell(s.state, input.amountIn, terms);
    if ('capacity' in q && !q.capacity) { out.unavailable.push('curve_capacity_limited'); return out; }
    const output = 'tokens' in q ? q.tokens : q.returned;
    if (output <= 0n) { out.unavailable.push('curve_capacity_limited'); return out; }
    uint(output, true);
    const minOut = output * BigInt(10000 - input.slippageBps) / 10000n;
    // Pons checks a buy's price after a clamp/refund, not an absolute output floor. Preserve the raw ABI minimum.
    if (minOut === 0n) { out.unavailable.push('minimum_rounds_to_zero'); return out; }
    out.expectedOut = output.toString(); out.minOut = minOut.toString(); out.charges = q.fees;
    if ('spent' in q) {
      out.predictedSpent = q.spent.toString(); out.predictedRefund = q.refund.toString();
      // TODO(spec): 040 refund gross-up rounding is candidate math until matched against deployed refund events/deltas.
      if (q.refund > 0n) out.unavailable.push('refund_rounding_unverified');
    }
    if (input.account && verifiedPonsExecution(r, input.abiPin)) out.candidate = buildPonsTrade(r, input.abiPin, {
      side: input.side, account: input.account, recipient: input.recipient ?? input.account, amountIn: input.amountIn, minOut,
    });
    return out;
  }
  /** TODO(spec): connect task 052 only after its actual-account revalidation implementation lands.
   * @remarks
   * Return actual_account_revalidation_052_missing unconditionally. Public preparation endpoint
   * without auth or I/O; it cannot emit executable order bytes.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  prepareExecution(): { status: 'unavailable'; code: 'actual_account_revalidation_052_missing' } {
    return { status: 'unavailable', code: 'actual_account_revalidation_052_missing' };
  }
}
