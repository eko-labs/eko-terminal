import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, toFunctionSelector, toHex, type Hex } from 'viem';
import {
  PonsCurveAdapter, buildPonsTrade, pendingPonsTradeForkGate, ponsExecutableSelectors, ponsTradeAbi,
  ponsTradeForkGateIssues, ponsV2Execution, ponsVenueLink, verifiedPonsExecution,
  type PonsAbiPin, type PonsQuoteSnapshot, type PonsTradeForkCase, type PonsTradeForkGate,
} from '../src/execution/pons.js';
import { ponsCall, ponsLegs, type PonsCurveRoute } from '../src/simulation/pons.js';
import { ponsBuy, ponsSell } from '../src/simulation/pons-math.js';
import { referenceDigest } from '../src/simulation/reference.js';
import { referenceTokenAbi } from '../src/simulation/v3.js';
import { address, cursor, hash } from './reference-fixtures.js';

const terms = (fee = 100n, creator = 200n) => [
  { kind: 'ordinary' as const, base: 'gross' as const, bps: fee, fixedWei: 0n },
  { kind: 'creator' as const, base: 'gross' as const, bps: creator, fixedWei: 0n },
];
function fixture() {
  const stateRead = { target: address(11), selector: '0x11111111' as Hex, words: [] };
  const route: PonsCurveRoute = {
    venue: 'pons_curve', id: 'sample-native-curve', coin: address(10), curve: address(11), spender: address(11), origin: 'fixture',
    verification: { reviewed: true, blockHash: cursor.blockHash as Hex, profileHash: hash('profile'), stateFingerprint: hash('state'),
      sourceRevision: hash('source'), evidenceIds: [hash('route')], pins: [10, 11].map(n => ({ address: address(n), codeHash: hash(`code-${n}`) })) },
    execution: ponsV2Execution(address(11)),
    stateReads: { tokens: stateRead, realQuote: stateRead, virtualQuote: stateRead, reservedTokens: stateRead },
    buyTerms: terms(), sellTerms: terms(), recipients: [address(12)], exemptions: { accounts: [], complete: true, evidenceIds: [hash('exemptions')] },
    entryLimitSelectors: [], sellCapacitySelectors: [], limits: { maxBuyWei: null, maxWalletTokens: null, evidenceIds: [hash('limits')] },
    cooldown: { seconds: 0, evidenceIds: [hash('cooldown')] }, decayEndSec: '999',
    feeAccounting: { gasIncludesL1: false, evidenceIds: [hash('fees')] }, contractClass: 'bw-probe',
  };
  const pin: PonsAbiPin = { blockHash: cursor.blockHash as Hex, sourceRevision: route.verification.sourceRevision,
    curveCodeHash: hash('code-11'), evidenceIds: [hash('abi-dispatcher')], buySelector: '0x59a87bc1', sellSelector: '0xd04c6983' };
  const snapshot: PonsQuoteSnapshot = { cursor, profileHash: route.verification.profileHash, stateFingerprint: route.verification.stateFingerprint,
    quoteAsset: 'native', evidenceIds: [hash('snapshot')], state: { tokens: 1000000n, realQuote: 100000n, virtualQuote: 100000n, reservedTokens: 500000n },
    feeBps: 100n, creatorTaxBps: 200n, currentSnipeTaxBps: 0n, graduated: false, readyToGraduate: false };
  const adapter = new PonsCurveAdapter({ ponsCurve: 'https://venue.example/curve', allowedOrigins: ['https://venue.example'] });
  const input = { route, abiPin: pin, snapshot, forkGate: pendingPonsTradeForkGate(), side: 'buy' as 'buy' | 'sell',
    amountIn: 10000n, slippageBps: 100, account: address(20), recipient: address(21), quotedAtMs: 1000000 };
  return { route, pin, snapshot, adapter, input };
}

describe('pinned deployed Pons v2 calldata', () => {
  it('matches every supplied deployed selector and uses local quotes without inventing quote getters', () => {
    for (const f of ponsExecutableSelectors) expect(toFunctionSelector(f.signature)).toBe(f.selector);
    expect(ponsExecutableSelectors.some(f => /quoteBuy|quoteSell/.test(f.signature))).toBe(false);
    const { route, pin } = fixture();
    expect(verifiedPonsExecution(route, pin)).toBe(true);
    expect(verifiedPonsExecution(route, null)).toBe(false);
    for (const change of [{ blockHash: hash('other-block') }, { curveCodeHash: hash('upgrade') },
      { sourceRevision: hash('other-source') }, { buySelector: '0x11111111' as Hex }, { evidenceIds: [] }]) {
      expect(verifiedPonsExecution(route, { ...pin, ...change })).toBe(false);
    }
    route.execution.sell.words.reverse();
    expect(verifiedPonsExecution(route, pin)).toBe(false);
  });
  it('encodes both directions with exact raw input/minimum and actual recipients, sharing 040 legs', () => {
    const { route, pin } = fixture(), amountIn = 2n ** 128n + 17n, minOut = 2n ** 100n + 9n;
    for (const side of ['buy', 'sell'] as const) {
      const trade = buildPonsTrade(route, pin, { side, account: address(20), recipient: address(21), amountIn, minOut });
      expect(trade.tx).toEqual({ chainId: 4663, to: route.curve, value: side === 'buy' ? amountIn.toString() : '0',
        data: encodeFunctionData({ abi: ponsTradeAbi, functionName: side, args: [amountIn, minOut, address(21)] }) });
      expect(decodeFunctionData({ abi: ponsTradeAbi, data: trade.tx.data }).args).toEqual([amountIn, minOut, address(21)]);
      if (side === 'buy') { expect(trade.approval).toBeNull(); expect(trade.refundRecipient).toBe(address(20)); }
      else {
        expect(trade.refundRecipient).toBeNull();
        expect(trade.approval?.amount).toBe(amountIn.toString()); expect(trade.approval?.spender).toBe(route.curve);
        expect(decodeFunctionData({ abi: referenceTokenAbi, data: trade.approval!.tx.data }).args).toEqual([route.curve, amountIn]);
      }
    }
    const execution = ponsV2Execution(route.curve);
    execution.buy.words[1] = toHex(minOut, { size: 32 }); execution.sell.words[1] = toHex(minOut, { size: 32 });
    const legs = ponsLegs({ ...route, execution }, address(21), amountIn);
    expect(legs.sell.amountOffset).toBe(4n);
    expect(legs.sellWithAmount(amountIn)).toBe(ponsCall(execution.sell, address(21), amountIn));
    expect(decodeFunctionData({ abi: ponsTradeAbi, data: legs.sell.data }).args).toEqual([0n, minOut, address(21)]);
  });
  it('rejects malformed bounds, targets, non-native spenders and absent ABI', () => {
    const { route, pin } = fixture(), input = { side: 'buy' as const, account: address(20), recipient: address(21), amountIn: 1n, minOut: 1n };
    for (const change of [{ amountIn: 0n }, { amountIn: -1n }, { amountIn: 2n ** 256n }, { minOut: 0n }, { minOut: 2n ** 256n }, { recipient: address(0) }]) {
      expect(() => buildPonsTrade(route, pin, { ...input, ...change })).toThrow();
    }
    expect(() => buildPonsTrade(route, null, input)).toThrow('ABI unavailable');
    expect(verifiedPonsExecution({ ...route, spender: address(12) }, pin)).toBe(false);
    expect(verifiedPonsExecution({ ...route, execution: { ...route.execution, buy: { ...route.execution.buy, target: address(12) } } }, pin)).toBe(false);
  });
});

describe('040 formula quotes and launch gates', () => {
  it('quotes buys and held-quantity sells with the pinned actual fee schedule and no EKO fee', () => {
    const { adapter, input, snapshot, route } = fixture();
    const buy = adapter.quote(input), expected = ponsBuy(snapshot.state, input.amountIn, route.buyTerms);
    expect(buy.expectedOut).toBe(expected.tokens.toString()); expect(buy.minOut).toBe((expected.tokens * 9900n / 10000n).toString());
    expect(buy.charges).toMatchObject({ ordinary: 100n, creator: 200n, total: 300n });
    expect(buy.fee).toEqual({ bps: 0, usd: 0, destination: null }); expect(buy.candidate?.approval).toBeNull();
    expect(buy.route).toMatchObject({ executable: false, linkOut: 'https://venue.example/curve' }); expect(buy.binding).toBe(false);
    expect(buy.expiresAtMs - buy.quotedAtMs).toBe(15000); expect(buy.refreshAfterMs - buy.quotedAtMs).toBe(5000);
    const sell = adapter.quote({ ...input, side: 'sell', amountIn: 20000n });
    const exit = ponsSell(snapshot.state, 20000n, route.sellTerms); expect(exit.capacity).toBe(true); if (!exit.capacity) return;
    expect(sell.expectedOut).toBe(exit.returned.toString()); expect(sell.candidate?.approval?.amount).toBe('20000');
    // The actual getter is not always the sample's 2% creator tax.
    snapshot.creatorTaxBps = 233n; route.buyTerms = terms(100n, 233n);
    expect(adapter.quote(input).charges?.creator).toBe(233n);
    route.buyTerms = terms(); expect(adapter.quote(input).unavailable).toContain('fee_schedule_unverified');
  });
  it('keeps active/unknown decay and refund rounding unaccepted; preserves full msg.value and sender refunds', () => {
    const { adapter, input, snapshot, route } = fixture();
    snapshot.currentSnipeTaxBps = 9900n;
    expect(adapter.quote(input)).toMatchObject({ expectedOut: null, candidate: null });
    expect(adapter.quote(input).unavailable).toContain('anti_snipe_model_unverified');
    snapshot.currentSnipeTaxBps = 0n; route.decayEndSec = null;
    expect(adapter.quote(input).unavailable).toContain('anti_snipe_model_unverified');
    route.decayEndSec = '999';
    const q = adapter.quote({ ...input, amountIn: 1000000n });
    expect(BigInt(q.predictedRefund!)).toBeGreaterThan(0n); expect(q.unavailable).toContain('refund_rounding_unverified');
    expect(q.amountIn).toBe('1000000'); expect(q.valueWei).toBe('1000000'); expect(q.candidate?.tx.value).toBe('1000000');
    expect(q.candidate?.refundRecipient).toBe(input.account);
    expect(decodeFunctionData({ abi: ponsTradeAbi, data: q.candidate!.tx.data }).args).toEqual([1000000n, BigInt(q.minOut!), input.recipient]);
  });
  it('returns explicit gaps for absent ABI, changed state, closed curve and insufficient sell capacity', () => {
    const { adapter, input, snapshot } = fixture();
    const missing = adapter.quote({ ...input, abiPin: null });
    expect(missing.expectedOut).not.toBeNull(); expect(missing.candidate).toBeNull(); expect(missing.unavailable).toContain('executable_abi_missing');
    expect(adapter.quote({ ...input, account: undefined }).candidate).toBeNull();
    expect(adapter.quote({ ...input, snapshot: { ...snapshot, stateFingerprint: hash('changed-state') } }).unavailable).toContain('quote_state_unverified');
    expect(adapter.quote({ ...input, snapshot: { ...snapshot, quoteAsset: 'erc20' } }).unavailable).toContain('quote_asset_unsupported');
    expect(adapter.quote({ ...input, snapshot: { ...snapshot, readyToGraduate: true } }).unavailable).toContain('curve_closed');
    expect(adapter.quote({ ...input, snapshot: { ...snapshot, graduated: true } }).candidate).toBeNull();
    expect(adapter.quote({ ...input, side: 'sell', amountIn: 2000000n }).unavailable).toContain('curve_capacity_limited');
    expect(adapter.prepareExecution()).toEqual({ status: 'unavailable', code: 'actual_account_revalidation_052_missing' });
  });
  it('validates config-owned HTTPS venue links and refuses arbitrary links', () => {
    for (const ponsCurve of ['http://venue.example/curve', 'https://user:password@venue.example/curve', 'https://other.example/curve', 'javascript:alert(1)']) {
      expect(() => ponsVenueLink({ ponsCurve, allowedOrigins: ['https://venue.example'] })).toThrow();
    }
    expect(ponsVenueLink({ ponsCurve: 'https://venue.example/curve', allowedOrigins: ['https://venue.example'] })).toBe('https://venue.example/curve');
  });
});

/** Synthetic supplied envelopes exercise validation; no measured chain evidence is created by these tests. */
function forkCases(route: PonsCurveRoute): PonsTradeForkCase[] {
  const fresh = (n: number) => ({ address: address(n), keyOrigin: 'fresh_generated' as const, codeAtPinnedBlock: '0x' as const, evidenceIds: [hash(`fresh-${n}`)] });
  const cases: PonsTradeForkCase[] = [];
  for (const sizeUsd of [100, 1000] as const) for (const accountClass of ['eoa', 'contract'] as const) for (const phase of ['active', 'expired'] as const) {
    cases.push({ id: hash(`${sizeUsd}-${accountClass}-${phase}`), origin: 'measured', blockHash: route.verification.blockHash, routeFingerprint: referenceDigest(route),
      sizeUsd, accountClass, phase, refundCase: false, gasPayer: fresh(30), buyRecipient: fresh(31), sellRecipient: fresh(32),
      gatewayEvidenceId: hash('gateway'), evidenceIds: [hash('case')], requestedQuote: 10000n, predictedSpent: 10000n, predictedTokens: 100n, predictedQuoteOut: 9000n,
      buyEvent: { recipient: address(31), spent: 10000n, tokensOut: 100n, fee: 100n, tax: 200n },
      sellEvent: { recipient: address(32), tokensIn: 100n, quoteOut: 9000n, fee: 92n, tax: 185n },
      tokenBalanceDelta: 100n, nativeBalanceDelta: 9000n, senderRefund: 0n, allowanceAfterApproval: 100n,
      expectedBuyFee: 100n, expectedBuyTax: 200n, expectedSellFee: 92n, expectedSellTax: 185n });
  }
  for (const accountClass of ['eoa', 'contract'] as const) cases.push({ ...cases.find(c => c.accountClass === accountClass)!,
    id: hash(`refund-${accountClass}`), refundCase: true, requestedQuote: 11000n, senderRefund: 1000n });
  return cases;
}
it('requires metered both-size/class active/expired/refund evidence, fresh no-code keys and event balance deltas', () => {
  const { route, adapter, input } = fixture();
  expect(ponsTradeForkGateIssues(route, pendingPonsTradeForkGate())).toEqual(['metered_fork_evidence_missing']);
  route.origin = 'measured'; const gate: PonsTradeForkGate = { status: 'supplied', cases: forkCases(route) };
  expect(ponsTradeForkGateIssues(route, gate)).toEqual([]);
  expect(adapter.quote({ ...input, forkGate: gate }).route.executable).toBe(false);
  expect(adapter.quote({ ...input, forkGate: gate }).unavailable).toContain('actual_account_revalidation_052_missing');
  const original = gate.cases[0];
  for (const change of [{ origin: 'fixture' as const }, { nativeBalanceDelta: 0n }, { tokenBalanceDelta: 99n },
    { allowanceAfterApproval: 2n ** 256n - 1n }, { senderRefund: 1n }, { gatewayEvidenceId: '0x' as Hex },
    { sellRecipient: original.gasPayer }, { buyEvent: { ...original.buyEvent, fee: 101n } },
    { gasPayer: { ...original.gasPayer, codeAtPinnedBlock: '0xef0100' as '0x' } }]) {
    gate.cases[0] = { ...original, ...change };
    expect(ponsTradeForkGateIssues(route, gate)).toContain('fork_assertion_mismatch');
  }
  gate.cases[0] = original;
  gate.cases = gate.cases.filter(c => c.sizeUsd !== 1000);
  expect(ponsTradeForkGateIssues(route, gate)).toContain('fork_case_missing:1000:contract:expired');
  gate.cases = forkCases(route).filter(c => !c.refundCase);
  expect(ponsTradeForkGateIssues(route, gate)).toContain('fork_refund_missing:eoa');
});
