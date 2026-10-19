import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { evaluate, orderHash, resolveRepeat, type Deps } from '@eko/policy';
import { AgentSchema, PolicySchema, PreflightRequestSchema, PreflightResultSchema,
  type Agent, type Approval, type Policy, type PreflightRequest, type PreflightResult } from '@eko/shared';
import type { ChainDb } from '@eko/db';
import { JournalService } from './journal.js';
import { HarnessError } from './service.js';
import { metrics } from '../obs/metrics.js';

/** Cache reads only. Acquisition belongs to 052; a miss returns its named queue/denial.
 * Never accept evidence, policy, approvals or release switches from tool context. Stored readers
 * use the supplied transaction (one connection, so a single-connection database cannot deadlock)
 * and resolve their lookups before the pure evaluation runs. */
export type CachedPreflightInputs = (request: PreflightRequest, policy: Policy, agent: Agent, now: number, tx: ChainDb) =>
  PreflightInputs | Promise<PreflightInputs>;
export type PreflightInputs = Omit<Deps, 'now' | 'approvalFor' | 'approvalsAvailable'>;
/**
 * Return cache-miss dependencies with the policy Guard version; verdict, card and price reads
 * return undefined. Pure fallback; it acquires no evidence and grants no execution permission.
 */
export const unavailablePreflightInputs: CachedPreflightInputs = (_request, policy) => ({
  guardPolicyV2: policy.guardPolicyVersion === 2,
  verdictFor: () => undefined, cardFor: () => undefined, priceFor: () => undefined,
});
/** Optional accepted D0 integration, absent at T. All approval writes share the transaction. */
export interface PreflightApprovals {
  available: boolean;
  current(tx: ChainDb, request: PreflightRequest, hash: `0x${string}`, now: number): Promise<Approval | undefined>;
  create(tx: ChainDb, request: PreflightRequest, hash: `0x${string}`, result: PreflightResult): Promise<Approval>;
}
type StoredRow = { order_hash: `0x${string}`; result: unknown };

export class PreflightService {
  /**
   * Wire storage, encrypted journal, cached evidence, optional approval adapter and clock. Host
   * construction starts no acquisition or worker; missing cache inputs remain unavailable.
   */
  constructor(private db: ChainDb, private journal: JournalService,
    private inputs: CachedPreflightInputs = unavailablePreflightInputs,
    private approvals?: PreflightApprovals, private clock: () => number = Date.now) {}

  /**
   * Validate input using authenticated agent identity, require journal consent/ownership, and
   * serialize agent/ref replay under owner-before-agent locks. Evaluate current policy with cached
   * evidence, bind optional approvals, and atomically persist preflight plus encrypted decision
   * journal. Hash conflicts use repeat rules; storage failures become bounded HarnessError text.
   * No signing or acquisition occurs.
   */
  async run(identity: { accountId: string; agentId: string }, raw: unknown): Promise<PreflightResult> {
    const started = performance.now();
    try {
      const parsed = PreflightRequestSchema.safeParse(typeof raw === 'object' && raw !== null
        ? { ...raw, agentId: identity.agentId } : raw);
      if (!parsed.success) throw new HarnessError('bad_request', 'Invalid preflight input');
      const req = parsed.data, hash = orderHash(req.order);
      return await this.db.tx(async tx => {
        // Owner-before-agent order matches deletion/lifecycle writers. Serializes
        // duplicates across processes, not merely within this service instance.
        await this.journal.authorizeInTransaction(tx, identity.accountId, identity.agentId);
        const row = (await tx.sql.query<Record<string, unknown>>(
          'SELECT * FROM agents WHERE id=$1 AND account_id=$2 FOR UPDATE', [identity.agentId, identity.accountId])).rows[0];
        if (!row) throw new HarnessError('not_found', 'Not found');
        const stored = (await tx.sql.query<StoredRow>('SELECT order_hash,result FROM preflights WHERE agent_id=$1 AND client_order_ref=$2 FOR UPDATE',
          [identity.agentId, req.clientOrderRef])).rows[0];
        const previous = stored ? { orderHash: stored.order_hash, result: PreflightResultSchema.parse(stored.result) } : undefined;
        if (previous && (previous.orderHash !== hash || previous.result.decision !== 'needs_approval'))
          return resolveRepeat(previous, hash, () => { throw new Error('Unexpected re-evaluation'); });

        const agent = AgentSchema.parse({ ...row, wallet: row.wallet ?? undefined,
          lastSeen: row.last_seen ? new Date(row.last_seen as string).toISOString() : undefined,
          guardrails: 'advisory', uncheckedOrders24h: 0 });
        const policyRow = (await tx.sql.query<{ policy: unknown; version: number }>(
          'SELECT policy,version FROM policies WHERE agent_id=$1 ORDER BY version DESC LIMIT 1', [agent.id])).rows[0];
        if (!policyRow) throw new HarnessError('internal_error', 'Preflight policy is unavailable');
        const policy = PolicySchema.parse(policyRow.policy);
        if (policy.version !== policyRow.version) throw new Error('Policy version mismatch');
        const now = this.clock();
        const approval = this.approvals?.available ? await this.approvals.current(tx, req, hash, now) : undefined;
        if (previous && this.approvals?.available && !approval)
          throw new HarnessError('internal_error', 'Preflight approval is unavailable');
        if (approval && !Number.isFinite(Date.parse(approval.expiresAt))) throw new Error('Invalid approval expiry');
        // An adapter must return the exact bound order; stale approval status is expired here.
        if (approval && (approval.agentId !== agent.id || approval.detail?.clientOrderRef !== req.clientOrderRef || approval.detail.orderHash !== hash ||
          previous && (approval.id !== previous.result.approvalId || approval.preflightId !== previous.result.preflightId))) throw new Error('Approval binding mismatch');
        const current = approval && Date.parse(approval.expiresAt) <= now && approval.status === 'pending'
          ? { ...approval, status: 'expired' as const } : approval;
        const deps: Deps = { ...await this.inputs(req, policy, agent, now, tx), now: () => now,
          approvalsAvailable: this.approvals?.available ?? false,
          approvalFor: (id, ref, h) => id === agent.id && ref === req.clientOrderRef && h === hash ? current : undefined };
        let result: PreflightResult = { ...evaluate(req, policy, agent, deps),
          preflightId: previous?.result.preflightId ?? randomUUID(), policyVersion: policy.version,
          journalId: randomUUID(), ...(current ? { approvalId: current.id } : {}) };
        if (previous) result = resolveRepeat(previous, hash, () => result);
        // Insert the preflight before the journal ownership check, then complete both
        // before commit. No partial replay state is visible outside this transaction.
        if (!previous) await tx.sql.query(`INSERT INTO preflights(id,agent_id,client_order_ref,order_hash,instrument,side,notional_usd,qty,
          decision,reasons,policy_version,approval_id,journal_id,result,latency_ms)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0)`,
        [result.preflightId,agent.id,req.clientOrderRef,hash,req.order.instrument,req.order.side,req.order.notionalUsd ?? null,req.order.qty ?? null,
          result.decision,JSON.stringify(result.reasons),policy.version,result.approvalId ?? null,result.journalId,JSON.stringify(result)]);
        if (result.decision === 'needs_approval' && !current) {
          const created = await this.approvals!.create(tx, req, hash, result);
          if (created.agentId !== agent.id || created.preflightId !== result.preflightId ||
            created.detail?.clientOrderRef !== req.clientOrderRef || created.detail.orderHash !== hash)
            throw new Error('Approval binding mismatch');
          result.approvalId = created.id;
        }
        // TODO(spec): decision-journal payload fields are unspecified. Keep the order hash,
        // size/asset summary and evaluation versions; omit calldata, positions and cards.
        const entry = await this.journal.appendInTransaction(tx, identity.accountId, agent.id, { kind: 'decision',
          preflightId: result.preflightId, payload: { clientOrderRef: req.clientOrderRef, order: { venue: req.order.venue, instrument: req.order.instrument,
              side: req.order.side, notionalUsd: req.order.notionalUsd ?? null, qty: req.order.qty ?? null }, orderHash: hash,
            decision: result.decision, reasons: result.reasons, policyVersion: policy.version,
            ...(result.guardPolicyVersion ? { guardPolicyVersion: result.guardPolicyVersion } : {}) } });
        result.journalId = entry.id;
        result = PreflightResultSchema.parse(result);
        const updated = await tx.sql.query(`UPDATE preflights SET decision=$2,reasons=$3,policy_version=$4,approval_id=$5,
          journal_id=$6,result=$7,latency_ms=$8,updated_at=now() WHERE id=$1 AND ($9::boolean OR decision='needs_approval') RETURNING id`,
        [result.preflightId,result.decision,JSON.stringify(result.reasons),policy.version,result.approvalId ?? null,entry.id,JSON.stringify(result),
          performance.now()-started,!previous]);
        if (updated.rows.length !== 1) throw new Error('Preflight compare-and-set failed');
        return result;
      });
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('internal_error', 'Preflight storage is unavailable');
    } finally {
      // Scalar timing only; telemetry failure must not change a committed result.
      try { metrics.observe('harness.preflight_ms', performance.now() - started); } catch {}
    }
  }
}
