import { encodeFunctionData, isAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { GuardCursorSchema, type GuardCursor, type UnsignedTx } from '@eko/shared';
import { referenceDigest } from '../simulation/reference.js';
import { supportedV4Route, v4FallbackLink, type V4ReferenceRoute, type V4VenueLinkConfig } from '../simulation/v4.js';
import { CHAIN_ID, type ChainId } from '@eko/shared';

export const v4ApprovalAbi = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
export const v4Permit2ApprovalAbi = parseAbi(['function approve(address token,address spender,uint160 amount,uint48 expiration)']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (s: string) => /^0x[0-9a-f]{64}$/i.test(s);
const address = (a: Address) => {
  if (!isAddress(a, { strict: false }) || same(a, zeroAddress)) throw new Error('Invalid v4 execution address');
};
const raw = (s: string, limit: bigint, positive = true) => {
  if (!/^(0|[1-9]\d*)$/.test(s) || s.length > 78) throw new Error('Invalid v4 raw amount');
  const n = BigInt(s);
  if (n < (positive ? 1n : 0n) || n >= limit) throw new Error('Invalid v4 raw amount');
  return n;
};

/** A separate router/Permit2 review is required: a direct PoolManager probe is insufficient. */
export interface V4ExecutionRoute {
  reference: V4ReferenceRoute; router: Address; permit2: Address;
  verification: { blockHash: Hex; reviewed: boolean; evidenceIds: Hex[];
    routerCodeHash: Hex; permit2CodeHash: Hex };
}
export interface V4ExecutionTerms {
  chainId: ChainId; cursor: GuardCursor; account: Address; recipient: Address; coin: Address;
  side: 'buy' | 'sell'; amountIn: string; expectedOut: string; minOut: string; valueWei: string;
  slippageBps: number; deadlineSec: string; approvalExpirationSec: string;
  routeFingerprint: Hex; profileHash: Hex; stateFingerprint: Hex; policyHash: Hex;
  orderHash: Hex; guardReceiptId: string;
}
/** Supplied by trusted retained quote acquisition, never an HTTP/MCP evidence parameter. */
export interface V4CheckedQuote { terms: V4ExecutionTerms; evidenceIds: Hex[] }
export interface V4ApprovalPlan {
  account: Address; token: Address; amount: string; expirationSec: string;
  erc20: UnsignedTx; permit2: UnsignedTx;
}

/** Review bytes only. The adapter never returns these as orderable transactions. */
export function buildV4ApprovalPlan(input: {
  account: Address; token: Address; permit2: Address; router: Address;
  amountIn: string; expirationSec: string; nowSec: string;
}): V4ApprovalPlan {
  for (const a of [input.account, input.token, input.permit2, input.router]) address(a);
  if (new Set([input.token, input.permit2, input.router].map(a => a.toLowerCase())).size !== 3)
    throw new Error('Invalid v4 approval targets');
  // Permit2 treats max uint160 as an infinite allowance, even if presented as an exact input.
  const amount = raw(input.amountIn, 2n ** 160n - 1n);
  const now = raw(input.nowSec, 2n ** 48n, false), expiration = raw(input.expirationSec, 2n ** 48n);
  if (expiration <= now || expiration - now > 1800n) throw new Error('Invalid v4 approval expiry');
  return { account: input.account, token: input.token, amount: input.amountIn, expirationSec: input.expirationSec,
    erc20: { chainId: CHAIN_ID, to: input.token, value: '0', data: encodeFunctionData({ abi: v4ApprovalAbi,
      functionName: 'approve', args: [input.permit2, amount] }) },
    permit2: { chainId: CHAIN_ID, to: input.permit2, value: '0', data: encodeFunctionData({ abi: v4Permit2ApprovalAbi,
      functionName: 'approve', args: [input.token, input.router, amount, Number(expiration)] }) } };
}

export interface V4ExecutionIntent {
  id: Hex; routeFingerprint: Hex; terms: V4ExecutionTerms; approvalReview: V4ApprovalPlan | null;
  fee: { bps: 0; destination: null };
}
/** Preserve exact trusted terms for a future planner; never construct hand-coded swap commands. */
export function bindV4ExecutionIntent(route: V4ExecutionRoute, checked: V4CheckedQuote,
  requested: V4ExecutionTerms, nowSec: string): V4ExecutionIntent {
  const t = structuredClone(checked.terms), r = route.reference, v = route.verification;
  if (referenceDigest(t) !== referenceDigest(requested)) throw new Error('V4 checked quote mismatch');
  const cursor = GuardCursorSchema.parse(t.cursor), fingerprint = referenceDigest(route);
  if (t.chainId !== CHAIN_ID || cursor.chainId !== CHAIN_ID || !supportedV4Route(r, cursor) ||
    t.routeFingerprint !== fingerprint || !same(t.coin, r.coin) || !v.reviewed ||
    !same(v.blockHash, cursor.blockHash) || !hash(v.routerCodeHash) || !hash(v.permit2CodeHash) ||
    !v.evidenceIds.length || !v.evidenceIds.every(hash) || !checked.evidenceIds.length || !checked.evidenceIds.every(hash))
    throw new Error('V4 execution route unverified');
  for (const a of [t.account, t.recipient, route.router, route.permit2]) address(a);
  if (new Set([route.router, route.permit2, r.coin, r.manager, r.quoter, r.stateView, r.key.hooks]
    .map(a => a.toLowerCase())).size !== 7) throw new Error('Invalid v4 execution targets');
  const amount = raw(t.amountIn, 2n ** 128n), expected = raw(t.expectedOut, 2n ** 128n), minimum = raw(t.minOut, 2n ** 128n);
  const value = raw(t.valueWei, 2n ** 256n, false), now = raw(nowSec, 2n ** 48n, false);
  const deadline = raw(t.deadlineSec, 2n ** 48n), expiration = raw(t.approvalExpirationSec, 2n ** 48n);
  if (!['buy', 'sell'].includes(t.side) || minimum > expected || value !== (t.side === 'buy' ? amount : 0n) ||
    !Number.isInteger(t.slippageBps) || t.slippageBps < 0 || t.slippageBps >= 10000 ||
    deadline <= now || expiration < deadline || expiration <= now || expiration - now > 1800n ||
    ![t.profileHash, t.stateFingerprint, t.policyHash, t.orderHash].every(hash) || !t.guardReceiptId)
    throw new Error('Invalid v4 checked terms');
  const approvalReview = t.side === 'buy' ? null : buildV4ApprovalPlan({ account: t.account, token: t.coin,
    permit2: route.permit2, router: route.router, amountIn: t.amountIn, expirationSec: t.approvalExpirationSec, nowSec });
  const intent = { routeFingerprint: fingerprint, terms: t, approvalReview, fee: { bps: 0 as const, destination: null } };
  return { id: referenceDigest(intent), ...intent };
}

/** Diagnostics over trusted metered fork artifacts. This is not an execution acceptance authority. */
export interface V4ExecutionForkCase {
  id: Hex; origin: 'fixture' | 'measured'; gatewayEvidenceId: Hex; evidenceIds: Hex[];
  intent: V4ExecutionIntent; accountClass: 'eoa' | 'smart_account';
  success: boolean; decodedCommandsMatch: boolean;
  actualSpent: string; actualOut: string; recipientOutputDelta: string;
  /** Gas is accounted separately from native trade balance deltas. */
  inputBalanceDelta: string; gasPaidWei: string; senderNativeDelta: string;
  /** Read after approvals, before the swap spends them; never post-spend allowance guesses. */
  erc20Allowance: string; permit2Allowance: string; permit2ExpirationSec: string;
  terminalFeeDelta: string;
}
/**
 * Diagnose supplied measured v4 fork cases against route bindings, decoded commands, balances,
 * gas, approvals and account-class/direction coverage. Return issue codes, including a missing-
 * case code; this pure diagnostic never accepts executable v4 capability.
 */
export function v4ExecutionForkIssues(route: V4ExecutionRoute, cases: readonly V4ExecutionForkCase[]): string[] {
  if (!cases.length) return ['v4_executable_fork_missing'];
  const issues: string[] = [], fingerprint = referenceDigest(route);
  const valid = (c: V4ExecutionForkCase) => {
    try {
      const { id, ...intent } = c.intent, t = c.intent.terms;
      // Reuse the binding validator at the pinned clock; supplied digests alone cannot certify a route.
      const rebound = bindV4ExecutionIntent(route, { terms: t, evidenceIds: c.evidenceIds }, t, t.cursor.timestampSec);
      const amount = raw(t.amountIn, 2n ** 128n), output = raw(c.actualOut, 2n ** 128n);
      return route.reference.origin === 'measured' && c.origin === 'measured' && hash(c.id) && hash(c.gatewayEvidenceId) &&
        c.evidenceIds.length > 0 && c.evidenceIds.every(hash) && id === referenceDigest(intent) && id === rebound.id &&
        c.intent.routeFingerprint === fingerprint && c.success && c.decodedCommandsMatch &&
        raw(c.actualSpent, 2n ** 128n) === amount && output === BigInt(t.expectedOut) && output >= BigInt(t.minOut) &&
        raw(c.recipientOutputDelta, 2n ** 128n) === output && raw(c.inputBalanceDelta, 2n ** 128n) === amount &&
        /^-?(0|[1-9]\d*)$/.test(c.senderNativeDelta) && c.senderNativeDelta.length <= 79 &&
        BigInt(c.senderNativeDelta) === (t.side === 'buy' ? -amount : same(t.account, t.recipient) ? output : 0n) - raw(c.gasPaidWei, 2n ** 256n, false) &&
        c.terminalFeeDelta === '0' && (t.side === 'buy' ? c.erc20Allowance === '0' && c.permit2Allowance === '0' :
          c.erc20Allowance === t.amountIn && c.permit2Allowance === t.amountIn && c.permit2ExpirationSec === t.approvalExpirationSec);
    } catch { return false; }
  };
  if (new Set(cases.map(c => c.id)).size !== cases.length || cases.some(c => !valid(c))) issues.push('v4_fork_assertion_mismatch');
  // TODO(spec): executable v4 fork sizes/counts are unspecified; require both directions and account classes as a diagnostic minimum, never acceptance.
  for (const side of ['buy', 'sell']) for (const accountClass of ['eoa', 'smart_account'])
    if (!cases.some(c => valid(c) && c.intent.terms.side === side && c.accountClass === accountClass))
      issues.push(`v4_fork_case_missing:${side}:${accountClass}`);
  return issues;
}

/** Offline capability result for task 075. Installing a package or supplying fixtures cannot flip it. */
export function v4ExecutionCapability() {
  return { version: 'v4-execution-1' as const, executable: false as const,
    sdk: { status: 'unavailable' as const, packages: ['@uniswap/v4-sdk', '@uniswap/universal-router-sdk'],
      reason: 'offline_metadata_unavailable' as const },
    commandDecoding: 'not_run' as const, executableForkGate: 'not_accepted' as const,
    actualAccountRevalidation: 'unavailable' as const };
}

/** Narrow native-ETH profile from 070. No keys, transport, fee leg or orderable approval/swap bytes. */
export class UniswapV4Adapter {
  /**
   * Wire optional verified venue link configuration only. Construction creates no SDK, provider
   * client, keys or execution bytes.
   */
  constructor(private readonly links: V4VenueLinkConfig = { pons: null }) {}
  /**
   * Validate the checked native-ETH route/terms for review and return a quote-only unavailable
   * result with no candidate or approvals. Binding errors become v4_checked_quote_mismatch; even
   * matching inputs remain v4_sdk_unavailable until the executable capability is accepted.
   */
  prepareExecution(input: { route: V4ExecutionRoute; checked: V4CheckedQuote;
    requested: V4ExecutionTerms; nowSec: string }) {
    const route = { venue: 'uniswap_v4' as const, poolId: input.route.reference.poolId,
      executable: false as const, linkOut: v4FallbackLink(input.route.reference, this.links) };
    try {
      const review = bindV4ExecutionIntent(input.route, input.checked, input.requested, input.nowSec);
      return { status: 'unavailable' as const, code: 'v4_sdk_unavailable', route, binding: false as const,
        candidate: null, approvals: [], review, capability: v4ExecutionCapability() };
    } catch {
      return { status: 'unavailable' as const, code: 'v4_checked_quote_mismatch', route, binding: false as const,
        candidate: null, approvals: [], review: null, capability: v4ExecutionCapability() };
    }
  }
}
