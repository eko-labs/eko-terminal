import { describe, expect, it } from 'vitest';
import { createKlikAdapter, klikSupport, resolveLaunchRolesV2 } from '@eko/chain';
import { CoinCardSchema, CoinCardV2Schema, GuardAssessmentV2Schema, GuardCursorSchema } from '@eko/shared';
import { projectCoinCardV2 } from '../src/read/guard-card.js';
import { projectGuardCardToV1 } from '../src/read/guard-compat.js';
import v1 from '../../../packages/shared/test/fixtures/contracts/v1.json' with { type: 'json' };
import { assessment, cursor as rawCursor, hash } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';

// Synthetic compatibility cases, not a discovered Klik launch or live risk evidence.
const coin = `0x${'ab'.repeat(20)}` as const;
const cursor = GuardCursorSchema.parse(rawCursor);
const cut = { cursor, acquisitionSequence: '1' };
function partialCard() {
  const snapshot = resolveLaunchRolesV2({ coin, cursor, name: 'Sample Token', symbol: 'SAMPLE', launchpad: 'klik', events: [], senders: [], exemptions: [] });
  return projectCoinCardV2({ coin, name: null, symbol: null, cursor, cut, servedAtSec: 1001, assessment: null, legacy: null, legacyRulesVersion: null,
    launch: { snapshot, evidence: { id: hash, kind: 'state', cursor, knownAt: cut, payloadHash: hash, objectRef: hash, supersedes: null } }, measurements: [] });
}

describe('Klik partial-card compatibility', () => {
  it('keeps absent risk inputs neutral and never inherits a Pons profile', () => {
    expect(klikSupport.status).toBe('unsupported');
    expect(createKlikAdapter().addresses()).toEqual([]);
    const card = CoinCardV2Schema.parse(partialCard());
    expect(card.identity.launchpad).toBe('klik');
    expect(card.identity.stage).toBe('unknown');
    for (const field of ['factoryDeployer', 'principal', 'creationPayer', 'quoteAsset'] as const) expect(card.identity[field]).toMatchObject({ status: 'unknown', value: null, failureCode: 'missing' });
    expect(card.tradeability.antiSnipe.value).toBeNull();
    expect(card.tradeability.quotes.every(q => q.routeId === null && q.sellability.value === null && q.venueCostPct.value === null)).toBe(true);
    expect(card.control.powers.every(p => p.reachable.value === null)).toBe(true);
    expect(card.liquidity.lpStatus.value).toBeNull();
    expect(card.collectionCoverage?.pools?.complete).toBe(false);
    expect(card.verdict).toBeNull();
    expect(projectGuardCardToV1(card, CoinCardSchema.parse(v1.CoinCard))).toBeNull();
  });

  it('retains shared V1 masks when independent synthetic issuer and assessment evidence exists', () => {
    const card = partialCard();
    // Only issuer/assessment prerequisites are supplied; venue risk remains unknown.
    card.verdict = GuardAssessmentV2Schema.parse(assessment);
    const known = { ...card.identity.principal, status: 'observed' as const, value: coin, failureCode: null,
      coverage: { ...card.identity.principal.coverage, complete: true, gaps: [] } };
    card.identity.principal = known;
    card.identity.factoryDeployer = { ...known, id: 'factoryDeployer' };
    const legacy = CoinCardSchema.parse(v1.CoinCard);
    legacy.identity.launchpad = 'klik';
    const before = JSON.stringify(legacy);
    const projected = projectGuardCardToV1(card, legacy)!;
    expect(projected.meta?.tradeability).toMatchObject({ unavailable: true, missing: expect.arrayContaining(['exitCostPct', 'buyTaxPct', 'sellTaxPct', 'honeypot']) });
    expect(projected.meta?.liquidity).toMatchObject({ unavailable: true, missing: expect.arrayContaining(['depthUsd']) });
    expect(projected.meta?.control).toMatchObject({ unavailable: true, missing: expect.arrayContaining(['canChangeTax', 'canBlacklist', 'canPause', 'canMint', 'upgradeable']) });
    expect(projected.meta?.flow).toMatchObject({ unavailable: true, missing: expect.arrayContaining(['agentPct', 'crewPct', 'humanPct', 'washEstPct']) });
    expect(projected.flow.humanPct).toBe(legacy.flow.humanPct);
    expect(JSON.stringify(legacy)).toBe(before);
  });
});
