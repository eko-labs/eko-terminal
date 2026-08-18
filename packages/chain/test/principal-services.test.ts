import { describe, expect, it } from 'vitest';
import { resolveService, resolveEffectiveControl, serviceRegistryHash } from '../src/index.js';
import type { ServiceRegistry, ServiceLaunchObservation, PermissionObservation } from '../src/index.js';
import { address, hash, cursor, at, account, otherAccount, sponsor, tool } from './fixtures/trace-principals.js';
const registry: ServiceRegistry = { version: '2.1.0', entries: [] };
const codeHash = hash(50), implementation = address(55);
function launches(count = 20): ServiceLaunchObservation[] {
  return Array.from({ length: count }, (_, i) => ({ id: `launch-${i}`, service: tool, codeHash, implementation, cursor, knownAt: at,
    principal: address(100 + i), authenticated: true, feeRecipient: address(200 + i) }));
}
const serviceInput = () => ({ registry, address: tool, codeHash, implementation, at, launches: launches(), launchCoverageComplete: true });
function permission(account: `0x${string}`): PermissionObservation {
  return { account, codeHash, implementation, effectiveFrom: { ...cursor, blockNumber: '120', blockHash: hash(120) }, effectiveUntil: null, knownAt: at,
    owners: [address(20), address(21)], threshold: 2, enabledModules: [address(22)], permissionCoverageComplete: true, evidenceIds: [hash(90)], paths: [] };
}
describe('043 service, hub, and effective control fixture boundaries', () => {
  it('qualifies exact 20/10/80% boundaries, deduplicates launches, and never turns a failed candidate into one operator', () => {
    const input = serviceInput(); input.launches = launches().map((l, i) => ({ ...l, principal: address(100 + i % 10), feeRecipient: i < 16 ? address(200 + i) : address(200 + i % 4) }));
    // Exactly 16 distinct pairs across 20 launches.
    for (let i = 16; i < 20; i++) input.launches[i] = { ...input.launches[i], principal: input.launches[i - 16].principal, feeRecipient: input.launches[i - 16].feeRecipient };
    const result = resolveService(input);
    expect(result).toMatchObject({ status: 'candidate', launches: 20, principals: 10, pairs: 16, pairDenominator: 20, stopControlExpansion: true, aggregateInfrastructureHistory: false, preserveEconomicExposure: true });
    expect(resolveService({ ...input, launches: [...input.launches, input.launches[0]] })).toEqual(result);
    for (const variant of [input.launches.slice(0, 19), input.launches.map(l => ({ ...l, principal: account })),
      input.launches.map((l, i) => i === 15 ? { ...l, principal: input.launches[0].principal, feeRecipient: input.launches[0].feeRecipient } : l),
      input.launches.map(l => ({ ...l, authenticated: false }))])
      expect(resolveService({ ...input, launches: variant })).toMatchObject({ status: 'unresolved', aggregateInfrastructureHistory: false });
  });
  it('confirms only reviewed independent callers/configuration at matching chain, code, implementation and effective cut', () => {
    const input = serviceInput();
    const entry: ServiceRegistry['entries'][number] = { chainId: 4663, address: tool, codeHash, implementation, effectiveFrom: { ...cursor, blockNumber: '120', blockHash: hash(120) }, effectiveUntil: null, knownAt: at,
      kind: 'shared_tool', independentCallers: [account, otherAccount], perUserConfigurationEvidence: [hash(60)], reviewEvidence: [hash(61)] };
    const reviewed = { version: '2.1.0', entries: [entry] };
    expect(resolveService({ ...input, registry: reviewed })).toMatchObject({ status: 'confirmed', reviewEvidence: [hash(61)] });
    expect(serviceRegistryHash({ ...reviewed, entries: [{ ...entry, independentCallers: [otherAccount, account] }] })).toBe(serviceRegistryHash(reviewed));
    expect(() => serviceRegistryHash({ ...reviewed, entries: [{ ...entry, independentCallers: [account, account] }] })).toThrow('callers');
    for (const change of [{ codeHash: hash(999) }, { implementation: address(999) }, { effectiveUntil: cursor }, { knownAt: { cursor, acquisitionSequence: '2' } }])
      expect(resolveService({ ...input, launches: [], registry: { ...reviewed, entries: [{ ...entry, ...change }] } }).status).toBe('unresolved');
  });
  it('uses exact trailing time/cursor cuts and rejects conflicting source revisions', () => {
    const input = serviceInput();
    const first = input.launches[0];
    expect(resolveService({ ...input, launches: input.launches.map((l, i) => i === 0 ? { ...l, cursor: { ...cursor, blockNumber: '100', blockHash: hash(100), timestampSec: '13600' } } : l) }).status).toBe('unresolved');
    expect(resolveService({ ...input, launches: input.launches.map((l, i) => i === 0 ? { ...l, knownAt: { cursor, acquisitionSequence: '2' } } : l) }).status).toBe('unresolved');
    expect(() => resolveService({ ...input, launches: [...input.launches, { ...first, principal: address(999) }] })).toThrow('Conflicting');
  });
  it('reviews private 501-counterparty camouflage without deleting endpoints/batch exposure, and never proves <500 from a candidate graph', () => {
    const input = { ...serviceInput(), launches: [] };
    const degree = { fromSec: '13600', throughSec: '100000', counterparties: Array.from({ length: 501 }, (_, i) => address(1000 + i)), complete: false, knownAt: at, evidenceIds: [hash(70)] };
    expect(resolveService({ ...input, degree })).toMatchObject({ status: 'unresolved', hub: 'review', degree: 501, degreeStatus: 'lower_bound', stopControlExpansion: true, preserveEconomicExposure: true });
    expect(resolveService({ ...input, degree: { ...degree, counterparties: degree.counterparties.slice(0, 499) } }).hub).toBe('unknown');
    expect(resolveService({ ...input, degree: { ...degree, counterparties: degree.counterparties.slice(0, 499), complete: true } }).hub).toBe('below_threshold');
    expect(resolveService({ ...input, degree: { ...degree, counterparties: degree.counterparties.slice(0, 500) } }).hub).toBe('review');
    expect(resolveService({ ...input, degree: { ...degree, fromSec: '13601' } }).degree).toBeNull();
  });
  it('keeps shared implementation, sponsor and identical owner sets separate without verified permission paths', () => {
    const permissions = [permission(account), permission(otherAccount)];
    expect(resolveEffectiveControl([account, otherAccount], sponsor, permissions, at)).toMatchObject({ status: 'unknown', authority: null });
    for (const p of permissions) p.paths.push({ authority: sponsor, kind: 'owner_quorum', signers: [address(20)], module: null, arbitraryEconomicActions: true, verifiedPermission: true, evidenceIds: [hash(91)] });
    expect(resolveEffectiveControl([account, otherAccount], sponsor, permissions, at).status).toBe('unknown');
    for (const p of permissions) p.paths[0].signers.push(address(21));
    expect(resolveEffectiveControl([account, otherAccount], sponsor, permissions, at)).toMatchObject({ status: 'verified', authority: sponsor, members: [account, otherAccount] });
    permissions[1].permissionCoverageComplete = false;
    expect(resolveEffectiveControl([account, otherAccount], sponsor, permissions, at).status).toBe('unknown');
  });
  it('requires effective enabled modules with economic permission and expires/revokes links', () => {
    const permissions = [permission(account), permission(otherAccount)];
    for (const p of permissions) p.paths.push({ authority: sponsor, kind: 'module', signers: [], module: address(22), arbitraryEconomicActions: true, verifiedPermission: true, evidenceIds: [hash(92)] });
    expect(resolveEffectiveControl([account, otherAccount], sponsor, permissions, at).status).toBe('verified');
    for (const change of [{ enabledModules: [] }, { effectiveUntil: cursor }, { knownAt: { cursor, acquisitionSequence: '2' } },
      { paths: [{ ...permissions[1].paths[0], arbitraryEconomicActions: false }] }])
      expect(resolveEffectiveControl([account, otherAccount], sponsor, [permissions[0], { ...permissions[1], ...change }], at).status).toBe('unknown');
  });
});
