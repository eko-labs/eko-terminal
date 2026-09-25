import { z } from 'zod';
import { Bytes32Schema } from '@eko/shared';
import { CampaignReplayInputSchema, applyPonsCampaignTransaction, campaignStateHash, ponsSell, referenceDigest, type CampaignState, type PonsCurveState } from '@eko/chain';
import { BenchmarkGasSchema, type BenchmarkExit } from './buyer-benchmark-input.js';
import { benchmarkRational, type BenchmarkAdapter } from './buyer-benchmark.js';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
export const PonsBenchmarkSnapshotSchema = z.strictObject({ campaign: CampaignReplayInputSchema.shape.checkpoint.shape.state,
  transactions: CampaignReplayInputSchema.shape.blocks.element.shape.transactions,
  gas: BenchmarkGasSchema, supportedClasses: z.array(z.enum(['eoa', 'contract'])), capQuote: uint.nullable(), cooldownSec: uint,
  blockedClasses: z.array(z.enum(['eoa', 'contract'])), verifiedFailure: z.boolean(), profileHash: Bytes32Schema });
const purchaseSchema = z.strictObject({ account: z.string(), acquiredAtSec: uint, cooldownSec: uint, quantity: uint });
const persistentSchema = CampaignReplayInputSchema.shape.checkpoint.shape.state;
/** Explicit synthetic normalized kernel. Never a measured fork, token-check decoder or deployed route certification. */
export const ponsBenchmarkFixtureAdapter: BenchmarkAdapter = {
  version: 'pons-benchmark-fixture-1',
  enter(m, path, frame, requestedQuote) {
    if (m.origin !== 'fixture') throw new Error('Pons benchmark adapter is fixture-only');
    const s = PonsBenchmarkSnapshotSchema.parse(frame.state);
    const evidenceIds = frame.evidenceIds;
    if (s.profileHash !== m.configHash || !s.supportedClasses.includes(path.accountClass) || !s.campaign.curve ||
        s.campaign.wallets.some(w => w.account.toLowerCase() === path.account.toLowerCase()) ||
        s.campaign.fees.overrides.some(w => w.account.toLowerCase() === path.account.toLowerCase()))
      return { status: 'unsupported', reason: 'unsupported', evidenceIds };
    if (s.capQuote !== null && BigInt(requestedQuote) > BigInt(s.capQuote)) return { status: 'entry_unavailable', reason: 'entry_cap', evidenceIds };
    const state = structuredClone(s.campaign), account = path.account as `0x${string}`;
    const legId = referenceDigest({ frame: frame.cursor, path, kind: 'synthetic_entry' });
    const tx = { id: referenceDigest({ legId }), index: 0, gasPayer: account, gasQuote: '0', gasRecipient: m.quoteAsset,
      expectedStateHash: referenceDigest({ legId, kind: 'synthetic' }), legs: [{ id: legId, economicId: null, kind: 'buy' as const,
        account, recipient: account, input: requestedQuote, minimumOutput: '1', deadlineSec: frame.cursor.timestampSec, executable: 'supported' as const }] };
    state.wallets.push({ account, quote: requestedQuote, token: '0', allowance: '0' });
    let bought: CampaignState;
    try { bought = applyPonsCampaignTransaction(state, tx, frame.cursor.timestampSec); }
    catch { return { status: 'entry_unavailable', reason: 'entry_failed', evidenceIds }; }
    const w = bought.wallets.find(w => w.account === account)!;
    return { status: 'purchased', quantity: w.token, spentQuote: (BigInt(requestedQuote) - BigInt(w.quote)).toString(), gas: s.gas,
      purchaseState: { account, acquiredAtSec: frame.cursor.timestampSec, cooldownSec: s.cooldownSec, quantity: w.token }, persistentState: bought, evidenceIds };
  },
  exit(m, path, entry, entryIndex, exitIndex) {
    if (m.origin !== 'fixture') throw new Error('Pons benchmark adapter is fixture-only');
    const purchase = purchaseSchema.parse(entry.purchaseState), at = m.frames[exitIndex], snap = PonsBenchmarkSnapshotSchema.parse(at.state);
    if (purchase.account !== path.account || purchase.quantity !== entry.quantity) throw new Error('Purchase-dependent wallet mismatch');
    const unknown = (status: 'indeterminate' | 'censored' | 'unsupported', reason: string, failedTransaction: `0x${string}` | null = null): BenchmarkExit =>
      ({ status, reason, failedTransaction, evidenceIds: at.evidenceIds });
    let state = snap.campaign;
    if (path.method === 'persistent') {
      state = persistentSchema.parse(entry.persistentState);
      for (const frame of m.frames.slice(entryIndex + 1, exitIndex + 1)) {
        if (frame.status !== 'available') return unknown(frame.status === 'unsupported' ? 'unsupported' : 'censored', frame.status);
        const next = PonsBenchmarkSnapshotSchema.parse(frame.state);
        for (const tx of next.transactions) {
          try { state = applyPonsCampaignTransaction(state, tx, frame.cursor.timestampSec); }
          catch { return unknown('indeterminate', 'persistent_transaction_invalid', tx.id); }
        }
      }
      const wallet = state.wallets.find(w => w.account === path.account);
      if (!wallet || wallet.token !== entry.quantity) return unknown('indeterminate', 'persistent_wallet_changed');
    }
    if (snap.profileHash !== m.configHash || !snap.supportedClasses.includes(path.accountClass) || !state.curve) return unknown('unsupported', 'unsupported_route_or_class');
    // Retain purchase storage even though the paper method discards the synthetic reserves.
    if (BigInt(at.cursor.timestampSec) < BigInt(purchase.acquiredAtSec) + BigInt(purchase.cooldownSec) || snap.blockedClasses.includes(path.accountClass))
      return { status: 'token_failure', verifiedNoExit: snap.verifiedFailure, validScheduledState: snap.verifiedFailure,
        grossQuote: snap.verifiedFailure ? '0' : null, gas: snap.gas, evidenceIds: at.evidenceIds };
    try {
      const curve = Object.fromEntries(Object.entries(state.curve).map(([k, v]) => [k, BigInt(v)])) as unknown as PonsCurveState;
      const terms = (state.fees.overrides.find(o => o.account === path.account)?.sell ?? state.fees.sell).map(t => ({ ...t, bps: BigInt(t.bps), fixedWei: BigInt(t.fixedWei) }));
      const quote = ponsSell(curve, BigInt(entry.quantity), terms);
      if (!quote.capacity) return unknown('indeterminate', 'capacity_unproved');
      return { status: 'executed', grossQuote: quote.returned.toString(), gas: snap.gas, evidenceIds: at.evidenceIds };
    } catch { return unknown('indeterminate', 'unsupported_charges_or_state'); }
  },
};
/** Verify original observed transactions before retaining their constraints in a synthetic replay. */
export function verifyPonsBenchmarkFixture(frames: { state: unknown; cursor: { timestampSec: string }; status: string }[]) {
  let previous: CampaignState | null = null;
  for (const frame of frames) {
    if (frame.status !== 'available') { previous = null; continue; }
    const snap = PonsBenchmarkSnapshotSchema.parse(frame.state);
    if (previous) {
      let s = previous;
      for (const [index, tx] of snap.transactions.entries()) {
        if (tx.index !== index) throw new Error('Observed transaction prefix mismatch');
        s = applyPonsCampaignTransaction(s, tx, frame.cursor.timestampSec);
        if (campaignStateHash(s) !== tx.expectedStateHash) throw new Error('Observed transaction state mismatch');
      }
      if (campaignStateHash(s) !== campaignStateHash(snap.campaign)) throw new Error('Observed block state mismatch');
    }
    previous = snap.campaign;
  }
}
export const zeroBenchmarkGas = () => ({ executionQuote: benchmarkRational(0n), l1Quote: benchmarkRational(0n), usd: benchmarkRational(0n) });
