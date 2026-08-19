import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, type Hex } from 'viem';
import { bindV4ExecutionIntent, buildV4ApprovalPlan, UniswapV4Adapter, v4ApprovalAbi,
  v4ExecutionCapability, v4ExecutionForkIssues, v4Permit2ApprovalAbi,
  type V4ExecutionForkCase, type V4ExecutionRoute, type V4ExecutionTerms } from '../src/execution/v4.js';
import { referenceDigest } from '../src/simulation/reference.js';
import { address, cursor, hash } from './reference-fixtures.js';
import { v4Route } from './v4-reference-fixtures.js';

function fixture(side: 'buy' | 'sell' = 'buy') {
  const route: V4ExecutionRoute = { reference: structuredClone(v4Route), router: address(50), permit2: address(51),
    verification: { blockHash: cursor.blockHash as Hex, reviewed: true, evidenceIds: [hash('fixture-router-review')],
      routerCodeHash: hash('fixture-router-code'), permit2CodeHash: hash('fixture-permit2-code') } };
  const terms: V4ExecutionTerms = { chainId: 4663, cursor, account: address(20), recipient: address(21), coin: route.reference.coin,
    side, amountIn: '1000', expectedOut: '990', minOut: '980', valueWei: side === 'buy' ? '1000' : '0',
    slippageBps: 100, deadlineSec: '1300', approvalExpirationSec: '1300', routeFingerprint: referenceDigest(route),
    profileHash: hash('fixture-profile'), stateFingerprint: hash('fixture-state'), policyHash: hash('fixture-policy'),
    orderHash: hash('fixture-order'), guardReceiptId: 'fixture-guard-receipt' };
  return { route, terms, checked: { terms: structuredClone(terms), evidenceIds: [hash('fixture-checked-quote')] }, nowSec: '1000' };
}

describe('v4 unsigned preparation with unavailable SDKs', () => {
  it('publishes quote-only capability and never returns a swap or orderable approvals', () => {
    for (const side of ['buy', 'sell'] as const) {
      const f = fixture(side), adapter = new UniswapV4Adapter();
      const result = adapter.prepareExecution({ ...f, requested: f.terms });
      expect(result).toMatchObject({ status: 'unavailable', code: 'v4_sdk_unavailable', binding: false,
        candidate: null, approvals: [], route: { executable: false, linkOut: null } });
      expect(result.review?.fee).toEqual({ bps: 0, destination: null });
      expect(result.review?.approvalReview === null).toBe(side === 'buy');
      expect(result.capability).toEqual(v4ExecutionCapability());
    }
    expect(v4ExecutionCapability()).toMatchObject({ executable: false, sdk: { status: 'unavailable' },
      commandDecoding: 'not_run', executableForkGate: 'not_accepted', actualAccountRevalidation: 'unavailable' });
    // A caller mutating a returned capability cannot activate a subsequent instance.
    const capability = v4ExecutionCapability(); capability.sdk.packages.length = 0;
    expect(v4ExecutionCapability().sdk.packages).toHaveLength(2);
  });

  it('decodes exact ERC-20 and Permit2 approval amounts, targets and bounded expiry', () => {
    const f = fixture('sell'), plan = bindV4ExecutionIntent(f.route, f.checked, f.terms, f.nowSec).approvalReview!;
    expect(plan.erc20).toMatchObject({ chainId: 4663, to: f.terms.coin, value: '0' });
    expect(plan.permit2).toMatchObject({ chainId: 4663, to: f.route.permit2, value: '0' });
    expect(plan.account).toBe(f.terms.account);
    expect(decodeFunctionData({ abi: v4ApprovalAbi, data: plan.erc20.data }).args).toEqual([f.route.permit2, 1000n]);
    expect(decodeFunctionData({ abi: v4Permit2ApprovalAbi, data: plan.permit2.data }).args)
      .toEqual([getAddress(f.terms.coin), getAddress(f.route.router), 1000n, 1300]);
    const input = { account: f.terms.account, token: f.terms.coin, permit2: f.route.permit2,
      router: f.route.router, amountIn: '1000', expirationSec: '2800', nowSec: '1000' };
    expect(buildV4ApprovalPlan(input).expirationSec).toBe('2800');
    for (const change of [{ expirationSec: '2801' }, { expirationSec: '1000' }, { expirationSec: '999' },
      { expirationSec: (2n ** 48n).toString() }, { amountIn: (2n ** 160n).toString() },
      { amountIn: (2n ** 160n - 1n).toString() },
      { amountIn: (2n ** 256n - 1n).toString() }, { amountIn: '0' }, { amountIn: '01' },
      { token: f.route.permit2 }, { account: address(0) }])
      expect(() => buildV4ApprovalPlan({ ...input, ...change })).toThrow();
  });

  it('rejects changed account, recipient, raw size, minimum, value, route and Guard bindings', () => {
    const f = fixture(), adapter = new UniswapV4Adapter();
    for (const change of [{ account: address(22) }, { recipient: address(22) }, { amountIn: '1001' },
      { minOut: '979' }, { expectedOut: '991' }, { valueWei: '999' }, { side: 'sell' as const },
      { routeFingerprint: hash('changed-route') }, { coin: address(23) }, { chainId: 1 as 4663 },
      { profileHash: hash('changed-profile') }, { stateFingerprint: hash('changed-state') },
      { policyHash: hash('changed-policy') }, { orderHash: hash('changed-order') },
      { guardReceiptId: 'changed-receipt' }, { slippageBps: 200 }, { deadlineSec: '1301' },
      { approvalExpirationSec: '1301' }, { cursor: { ...cursor, blockHash: hash('changed-block') } }]) {
      expect(adapter.prepareExecution({ ...f, requested: { ...f.terms, ...change } }))
        .toMatchObject({ code: 'v4_checked_quote_mismatch', candidate: null, approvals: [], review: null });
    }
    const altered = structuredClone(f.route); altered.reference.hookData = '0xabcd';
    expect(() => bindV4ExecutionIntent(altered, f.checked, f.terms, f.nowSec)).toThrow('unverified');
  });

  it('refuses self-consistent but invalid native terms and unreviewed execution profiles', () => {
    const f = fixture();
    for (const change of [{ valueWei: '999' }, { minOut: '991' }, { amountIn: '0' },
      { amountIn: (2n ** 128n).toString() }, { slippageBps: 10000 }, { deadlineSec: '1000' },
      { approvalExpirationSec: '1299' }, { approvalExpirationSec: '2801' }, { account: address(0) }]) {
      const t = { ...f.terms, ...change };
      expect(() => bindV4ExecutionIntent(f.route, { ...f.checked, terms: t }, t, f.nowSec)).toThrow();
    }
    const sell = fixture('sell'); sell.terms.valueWei = '1'; sell.checked.terms = sell.terms;
    expect(() => bindV4ExecutionIntent(sell.route, sell.checked, sell.terms, sell.nowSec)).toThrow();
    f.route.verification.reviewed = false;
    expect(() => bindV4ExecutionIntent(f.route, f.checked, f.terms, f.nowSec)).toThrow();
    const unsupported = fixture(); unsupported.route.reference.verification.reviewed = false;
    expect(() => bindV4ExecutionIntent(unsupported.route, unsupported.checked, unsupported.terms, unsupported.nowSec)).toThrow();
    const missing = fixture(); missing.checked.evidenceIds = [];
    expect(() => bindV4ExecutionIntent(missing.route, missing.checked, missing.terms, missing.nowSec)).toThrow();
  });

  it('owns an immutable review snapshot and uses only allowlisted configured Pons links', () => {
    const f = fixture(), intent = bindV4ExecutionIntent(f.route, f.checked, f.terms, f.nowSec);
    f.checked.terms.amountIn = '2000';
    expect(intent.terms.amountIn).toBe('1000');
    const pons = fixture(); pons.route.reference.launchpad = 'pons';
    const adapter = new UniswapV4Adapter({ pons: { baseUrl: 'https://venue.example/trade', allowedOrigins: ['https://venue.example'] } });
    // Missing successor state still denies preparation; the config-owned link remains available.
    expect(adapter.prepareExecution({ ...pons, requested: pons.terms }).route)
      .toMatchObject({ executable: false, linkOut: `https://venue.example/trade?chainId=4663&token=${pons.terms.coin}` });
    expect(new UniswapV4Adapter({ pons: { baseUrl: 'https://other.example/trade', allowedOrigins: ['https://venue.example'] } })
      .prepareExecution({ ...pons, requested: pons.terms }).route.linkOut).toBeNull();
  });
});

/** Synthetic envelopes exercise the checker; origin labels here are not live evidence. */
function cases(route: V4ExecutionRoute): V4ExecutionForkCase[] {
  return (['buy', 'sell'] as const).flatMap(side => (['eoa', 'smart_account'] as const).map(accountClass => {
    const f = fixture(side); f.route = route; f.terms.routeFingerprint = referenceDigest(route); f.checked.terms = f.terms;
    const intent = bindV4ExecutionIntent(route, f.checked, f.terms, f.nowSec);
    return { id: hash(`synthetic-${side}-${accountClass}`), origin: 'measured' as const,
      gatewayEvidenceId: hash('synthetic-gateway'), evidenceIds: [hash('synthetic-fork')], intent, accountClass,
      success: true, decodedCommandsMatch: true, actualSpent: '1000', actualOut: '990', recipientOutputDelta: '990',
      inputBalanceDelta: '1000', gasPaidWei: '10', senderNativeDelta: side === 'buy' ? '-1010' : '-10',
      erc20Allowance: side === 'buy' ? '0' : '1000', permit2Allowance: side === 'buy' ? '0' : '1000',
      permit2ExpirationSec: '1300', terminalFeeDelta: '0' };
  }));
}

it('checks matched buy/sell fork deltas and exact pre-spend allowances without accepting execution', () => {
  const f = fixture(); f.route.reference.origin = 'measured';
  const supplied = cases(f.route);
  expect(v4ExecutionForkIssues(f.route, [])).toEqual(['v4_executable_fork_missing']);
  expect(v4ExecutionForkIssues(f.route, supplied)).toEqual([]);
  for (const change of [{ actualSpent: '999' }, { actualOut: '991' }, { recipientOutputDelta: '989' },
    { inputBalanceDelta: '1001' }, { senderNativeDelta: '-1000' }, { terminalFeeDelta: '1' },
    { origin: 'fixture' as const }, { success: false }, { decodedCommandsMatch: false },
    { gatewayEvidenceId: '0x' as Hex }]) {
    const modified = structuredClone(supplied); modified[0] = { ...modified[0], ...change };
    expect(v4ExecutionForkIssues(f.route, modified)).toContain('v4_fork_assertion_mismatch');
  }
  for (const change of [{ erc20Allowance: (2n ** 256n - 1n).toString() },
    { permit2Allowance: '1001' }, { permit2ExpirationSec: '2801' }]) {
    const modified = structuredClone(supplied); modified[2] = { ...modified[2], ...change };
    expect(v4ExecutionForkIssues(f.route, modified)).toContain('v4_fork_assertion_mismatch');
  }
  const modified = structuredClone(supplied); modified[0].intent.terms.account = address(22);
  expect(v4ExecutionForkIssues(f.route, modified)).toContain('v4_fork_assertion_mismatch');
  expect(v4ExecutionForkIssues(f.route, supplied.filter(c => c.intent.terms.side === 'buy')))
    .toContain('v4_fork_case_missing:sell:smart_account');
  expect(v4ExecutionForkIssues(f.route, [...supplied, supplied[0]]))
    .toContain('v4_fork_assertion_mismatch');
  expect(v4ExecutionCapability().executable).toBe(false);
});
