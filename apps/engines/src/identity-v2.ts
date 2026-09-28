import { CoinCardV2Schema, GuardStoredEvidenceSchema } from '@eko/shared';
import type { CoinCardV2, GuardStoredEvidence, Metric, RoleAssignment } from '@eko/shared';
import { guardRowsKnownAt } from '@eko/db';
import type { ChainDb, GuardReadCut } from '@eko/db';
import { LaunchRoleSnapshotSchema } from '@eko/chain';
import type { LaunchRoleSnapshot } from '@eko/chain';
import { keccak256, toHex } from 'viem';
import { toUntrusted } from '@eko/untrusted';

/** Read-only V2 partial-card identity. V1's deployer/sender gates stay in loadSources. */
export async function loadLaunchIdentityV2(db: ChainDb, cut: GuardReadCut) {
  const rows = await guardRowsKnownAt<GuardStoredEvidence>(db, 'guard_chain_evidence', cut);
  const row = rows.filter(r => r.data.sourceItemId === 'launch-roles').at(-1);
  if (!row) return null;
  const stored = GuardStoredEvidenceSchema.parse(row.data);
  const content = (row as typeof row & { content: Uint8Array }).content;
  if (keccak256(toHex(content)) !== stored.evidence.payloadHash) throw new Error('Launch identity content hash mismatch');
  const snapshot = LaunchRoleSnapshotSchema.parse(JSON.parse(new TextDecoder().decode(content)).snapshot);
  if (snapshot.coin !== stored.coin || JSON.stringify(snapshot.cursor) !== JSON.stringify(stored.cursor)) throw new Error('Launch identity source mismatch');
  const evidenceIds = [row.id as `0x${string}`];
  function makeMetric(id: Metric<never>['id'], value: null, unit: Metric<never>['unit'], cursor?: LaunchRoleSnapshot['cursor']): Extract<Metric<never>, { status: 'unknown' }>;
  function makeMetric<T>(id: Metric<T>['id'], value: T | null, unit: Metric<T>['unit'], cursor?: LaunchRoleSnapshot['cursor']): Metric<T>;
  function makeMetric(id: Metric<unknown>['id'], value: unknown, unit: Metric<unknown>['unit'], cursor = snapshot.cursor): Metric<unknown> { return ({
    id, unit, cursor, knownAt: stored.knownAt, numerator: null, denominator: null, denominatorKind: null, fromSec: null, throughSec: cursor.timestampSec,
    coverage: { scopeId: `launch-${id}`, from: null, through: cursor, complete: value !== null, gaps: value === null ? ['missing'] : [],
      methodVersion: stored.methodVersion, coveredUnits: null, excludedUnits: null, topLevelNative: false, internalNative: false, firstEverEstablished: false, sourceHashes: [stored.evidence.payloadHash] },
    methodVersion: stored.methodVersion, evidenceIds, ...(value === null ? { status: 'unknown', value: null, failureCode: 'missing' } : { status: 'observed', value, failureCode: null }),
  }); }
  const roleMetric = (kind: LaunchRoleSnapshot['roles'][number]['role'], id: Metric<string>['id']) => {
    const r = snapshot.roles.find(r => r.role === kind);
    return makeMetric(id, r?.status === 'verified' ? r.address : null, 'address', r?.cursor);
  };
  const assignments = (kind: RoleAssignment['role']): RoleAssignment[] => snapshot.roles.filter(r => r.role === kind).map(r => ({
    role: kind, address: makeMetric('principal', r.status === 'verified' ? r.address : null, 'address', r.cursor), effectiveCursor: r.cursor, evidenceIds,
  }));
  const identity: CoinCardV2['identity'] = {
    chainId: snapshot.cursor.chainId, address: snapshot.coin, name: toUntrusted(snapshot.name ?? '', 120), symbol: toUntrusted(snapshot.symbol ?? '', 32),
    factoryDeployer: roleMetric('factory_deployer', 'factoryDeployer'), outerSigner: roleMetric('outer_signer', 'outerSigner'),
    principal: roleMetric('launch_principal', 'principal'), creationPayer: roleMetric('creation_payer', 'creationPayer'),
    createdAt: makeMetric('createdAt', snapshot.createdAtSec, 'seconds'),
    marketOpen: makeMetric('marketOpen', snapshot.launchpad === 'pons' ? snapshot.createdAtSec : null, 'seconds'),
    firstTrade: makeMetric('firstTrade', snapshot.firstTradeSec, 'seconds'), graduation: makeMetric('graduation', null, 'seconds'),
    launchpad: snapshot.launchpad, stage: 'unknown', quoteAsset: makeMetric('quoteAsset', snapshot.quoteAsset, 'address'), pools: [],
    service: { status: snapshot.jobs.some(j => j.kind === 'service_review') ? 'unresolved' : 'not_applicable',
      address: roleMetric('factory_deployer', 'factoryDeployer'), codeHash: null, implementation: makeMetric('principal', null, 'address'),
      effectiveCursor: snapshot.cursor, registryVersion: stored.methodVersion,
      launches: makeMetric('serviceLaunchCount', null, 'count'), principals: makeMetric('servicePrincipalCount', null, 'count'),
      distinctPairsPct: makeMetric('distinctPrincipalFeePairsPct', null, 'pct'), degree: makeMetric('hubDegree', null, 'count'),
      degreeCoverage: makeMetric('hubDegree', null, 'count').coverage, evidenceIds },
    operatorGroup: null, feeRecipients: assignments('fee_recipient'), exemptions: assignments('exempt'), clone: makeMetric('clone', null, 'compound'),
  };
  if (snapshot.service) {
    const service = snapshot.service;
    function countMetric(id: 'serviceLaunchCount' | 'servicePrincipalCount' | 'hubDegree', value: number | null, complete: boolean): Metric<number> {
      const m = makeMetric(id, value === 0 && !complete ? null : value, 'count', service.cursor);
      if (m.status === 'unknown' || m.status === 'not_applicable') return m;
      return { ...m, status: complete ? 'observed' : 'lower_bound', coverage: { ...m.coverage, complete, gaps: complete ? [] : ['missing'] } };
    }
    const numerator = BigInt(service.pairs) * 100n, denominator = BigInt(service.pairDenominator), scale = 10n ** 18n;
    let value: string | null = null;
    if (denominator > 0n && service.pairCoverageComplete) {
      let scaled = numerator * scale / denominator; const rem = numerator * scale % denominator;
      if (rem * 2n > denominator || rem * 2n === denominator && scaled % 2n !== 0n) scaled++;
      const tail = (scaled % scale).toString().padStart(18, '0').replace(/0+$/, '');
      value = `${scaled / scale}${tail ? `.${tail}` : ''}`;
    }
    const pct = makeMetric('distinctPrincipalFeePairsPct', value, 'pct', service.cursor);
    const degree = { ...countMetric('hubDegree', service.degree, service.degreeStatus === 'observed'), fromSec: service.degreeCoverage?.fromSec ?? null };
    identity.service = { status: service.status, address: makeMetric('factoryDeployer', service.address, 'address'), codeHash: service.codeHash,
      implementation: makeMetric('principal', service.implementation, 'address', service.cursor), effectiveCursor: service.effectiveCursor, registryVersion: service.registryVersion,
      launches: countMetric('serviceLaunchCount', service.launches, service.launchCoverageComplete), principals: countMetric('servicePrincipalCount', service.principals, service.principalCoverageComplete),
      distinctPairsPct: pct.status === 'observed' ? { ...pct, numerator: numerator.toString(), denominator: denominator.toString(), denominatorKind: 'other' } : pct,
      degree, degreeCoverage: degree.coverage, evidenceIds };
  }
  return {
    // Validate the same strict identity boundary used by the complete card in 026.
    identity: CoinCardV2Schema.shape.identity.parse(identity),
    economicRecipients: [...assignments('buy_recipient'), ...assignments('proceeds_recipient')],
    economicRoles: [...assignments('buy_payer'), ...assignments('buy_recipient'), ...assignments('sell_source'), ...assignments('proceeds_recipient')],
    feeConfiguration: snapshot.feeConfiguration, jobs: snapshot.jobs,
    metadataGaps: [...(snapshot.name === null ? ['name'] : []), ...(snapshot.symbol === null ? ['symbol'] : [])],
    evidence: { ...stored.evidence, id: evidenceIds[0] },
  };
}
