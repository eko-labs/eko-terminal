import { withRpcOrigin } from '@eko/chain';
import { ponsCurveAbi, type createMeteredClients } from '@eko/chain';
import { binary, GuardMeasurementStore, type ChainDb } from '@eko/db';
import { canonicalize } from '@eko/policy';
import { keccak256, toHex } from 'viem';
import { GuardCursorSchema, compareGuardCursors } from '@eko/shared';
import type { Address, GuardCursor, GuardAvailabilityManifest } from '@eko/shared';
import { PonsControlInputSchema, assessPonsControlProfile, controlProfileHash, controlStateFingerprint, controlEvidenceIds, controlCardMeasurements, type PonsControlInput,
  type ReviewedPonsTemplate, type ControlProbe } from './control-profile.js';

/** Explicit acquisition only. The caller supplies the existing metered archive client; no CLI job or connection is created. */
export async function acquirePonsGetterObservations(clients: Pick<ReturnType<typeof createMeteredClients>, 'archive'>,
  coin: Address, curve: Address, raw: GuardCursor) {
  const cursor = GuardCursorSchema.parse(raw), blockNumber = BigInt(cursor.blockNumber);
  if (cursor.chainId !== 4663 || cursor.boundary !== 'block_end') throw new Error('Unsupported profile cursor');
  const check = async () => {
    const block = await clients.archive.getBlock({ blockNumber });
    if (block.hash?.toLowerCase() !== cursor.blockHash.toLowerCase() || block.timestamp.toString() !== cursor.timestampSec)
      throw new Error('Profile acquisition pin mismatch');
  };
  await check();
  const contracts = [
    {address:curve,abi:ponsCurveAbi,functionName:'creatorTaxBps'},
    {address:curve,abi:ponsCurveAbi,functionName:'feeBps'},
    {address:curve,abi:ponsCurveAbi,functionName:'currentSnipeTaxBps',args:[coin]},
    {address:curve,abi:ponsCurveAbi,functionName:'launchedAt'},
  ] as const;
  const [tokenCode,curveCode,values]=await Promise.all([
    withRpcOrigin('engines.control_acquisition.L28.c1',()=>clients.archive.getCode({address:coin,blockNumber})),withRpcOrigin('engines.control_acquisition.L28.c2',()=>clients.archive.getCode({address:curve,blockNumber})),
    clients.archive.multicall ? withRpcOrigin('engines.control_acquisition.L29',()=>clients.archive.multicall({allowFailure:false,blockNumber,contracts})) :
      Promise.all(contracts.map(contract=>withRpcOrigin('engines.control_acquisition.L30',()=>clients.archive.readContract({...contract,blockNumber})))),
  ]);
  const [creator,fee,snipe,launchedAt]=values;
  if (typeof creator !== 'bigint' || typeof fee !== 'bigint' || typeof snipe !== 'bigint' || typeof launchedAt !== 'bigint') throw new Error('Invalid getter result');
  if (!tokenCode || tokenCode === '0x' || !curveCode || curveCode === '0x' || [creator, fee, snipe].some(v => v < 0n || v > 10000n))
    throw new Error('Invalid Pons getter observation');
  await check();
  const rawObservation = { cursor, coin, curve, tokenCode, curveCode, creator: creator.toString(), fee: fee.toString(),
    snipe: snipe.toString(), launchedAt: launchedAt.toString() }, id = controlProfileHash(rawObservation);
  return { rawObservation, evidenceId: id, tokenCodeHash: keccak256(tokenCode), curveCodeHash: keccak256(curveCode),
    getters: { creatorTaxBps: creator.toString(), feeBps: fee.toString(), currentSnipeTaxBps: snipe.toString(),
      launchedAtSec: launchedAt.toString(), evidenceIds: [id] } };
}

/** Private isolated fork lease, supplied by the runner. No broadcast/public-wallet interface.
 * readEffect must capture the capability's actual effect (balance/transfer/fee/code/custody), not its reported getter.
 * The permission path review supplies the authorized caller; no owner slot alone is accepted.
 */
export interface ControlForkLease {
  reset(cursor: GuardCursor): Promise<void>;
  fingerprint(): Promise<`0x${string}`>;
  readEffect(capability: ControlProbe['capability']): Promise<unknown>;
  execute(input: { authority: Address; target: Address; data: `0x${string}`; value: string }): Promise<{
    success: boolean; transactionHash: `0x${string}`; evidenceIds: `0x${string}`[] }>;
  advanceTo?(timestampSec: string): Promise<void>;
  close(): Promise<void>;
}
export type ControlProbePlan = Omit<ControlProbe, 'success' | 'beforeHash' | 'afterHash' | 'transactionHash' | 'evidenceIds' | 'stateFingerprint'> & {
  target: Address; data: `0x${string}`; value: string;
  prepare?: { authority: Address; target: Address; data: `0x${string}`; value: string } };
/** Serial reset before each state-changing test, finally close, bounded to the eight defined capabilities. */
export async function runControlProbes(lease: ControlForkLease, input: PonsControlInput, plans: ControlProbePlan[]): Promise<ControlProbe[]> {
  if (plans.length > 8 || new Set(plans.map(p => p.capability)).size !== plans.length) throw new Error('Invalid control probe plan');
  input = PonsControlInputSchema.parse(input);
  const fingerprint = controlStateFingerprint(input), result: ControlProbe[] = [];
  try {
    for (const { target, data, value, prepare, ...plan } of plans) {
      await lease.reset(input.cursor);
      if (await lease.fingerprint() !== fingerprint) throw new Error('Fork control profile mismatch');
      const beforeHash = controlProfileHash(await lease.readEffect(plan.capability));
      const setup = prepare ? await lease.execute(prepare) : null;
      if (setup && !setup.success) throw new Error('Fork permission preparation failed');
      if (BigInt(plan.earliestExecutionSec) > BigInt(input.cursor.timestampSec)) {
        if (!lease.advanceTo) throw new Error('Fork delayed control execution unavailable');
        await lease.advanceTo(plan.earliestExecutionSec);
      }
      const transaction = await lease.execute({ authority: plan.authority, target, data, value });
      const afterHash = controlProfileHash(await lease.readEffect(plan.capability));
      const p = { ...plan, ...transaction, evidenceIds: [...(setup?.evidenceIds ?? []), ...transaction.evidenceIds], beforeHash, afterHash, stateFingerprint: fingerprint };
      result.push(PonsControlInputSchema.shape.probes.element.parse(p));
    }
  } finally { await lease.close(); }
  return result;
}
/** Normalizer-owned writes happen only on explicit validated acquisition, never loadSources.
 * Guard storage provides immutable revisions, source availability and dependency/reorg invalidation.
 */
export async function persistPonsControlProfile(db: ChainDb, input: PonsControlInput, template: ReviewedPonsTemplate | undefined,
  context: { manifest: GuardAvailabilityManifest; acquiredAt: string; dependencyIds: `0x${string}`[] }) {
  if (controlEvidenceIds(input, template).some(id => !context.dependencyIds.includes(id))) throw new Error('Profile evidence dependency missing');
  if (input.origin !== 'measured' || template && template.origin !== 'measured') throw new Error('Fixture profile cannot be recorded as measured');
  const snapshot = assessPonsControlProfile(input, template), { manifest } = context;
  if (compareGuardCursors(input.knownAt.cursor, manifest.cut.cursor) > 0 || input.knownAt.acquisitionSequence !== manifest.cut.acquisitionSequence)
    throw new Error('Profile availability mismatch');
  const content = new TextEncoder().encode(canonicalize(snapshot)), hash = keccak256(toHex(content));
  return db.tx(async tx => {
    if (await tx.blockHash(BigInt(input.cursor.blockNumber)) !== input.cursor.blockHash) throw new Error('Profile persistence pin mismatch');
    const stored = await new GuardMeasurementStore(tx).putEvidence({ chainId: input.cursor.chainId, coin: input.coin,
      manifestId: manifest.id, sourceRevision: manifest.sourceRevision, sourceItemId: 'pons-control-profile',
      cursor: input.cursor, knownAt: input.knownAt, acquiredAt: context.acquiredAt, methodVersion: '2.0.0', dependencyIds: context.dependencyIds,
      evidence: { id: hash, kind: 'state', cursor: input.cursor, knownAt: input.knownAt, payloadHash: hash, objectRef: hash, supersedes: null } }, content);
    const cardContent = new TextEncoder().encode(canonicalize(controlCardMeasurements(snapshot))), cardHash = keccak256(toHex(cardContent));
    const cardStored = await new GuardMeasurementStore(tx).putEvidence({ ...stored.data, sourceItemId: 'pons-control-card', dependencyIds: [stored.id as `0x${string}`],
      evidence: { id: cardHash, kind: 'state', cursor: input.cursor, knownAt: input.knownAt, payloadHash: cardHash, objectRef: cardHash, supersedes: null } }, cardContent);
    if (snapshot.templateRevision && snapshot.checks.every(c => c.status === 'complete'))
      await tx.sql.query(`INSERT INTO code_templates(codehash,template,profile,first_block) VALUES($1,'pons-effective-2',$2,$3) ON CONFLICT DO NOTHING`,
        [snapshot.stateFingerprint, JSON.stringify({ template, evidenceId: stored.id, profileHash: snapshot.profileHash }), input.cursor.blockNumber]);
    // No default false powers: preserve the full tri-state assessment and profile dependency.
    await tx.sql.query('INSERT INTO owner_powers(coin,valid_from_block,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [binary(input.coin), input.cursor.blockNumber, JSON.stringify({ ...snapshot.control, profileHash: snapshot.profileHash, evidenceId: stored.id })]);
    return { snapshot, stored, cardStored };
  });
}
