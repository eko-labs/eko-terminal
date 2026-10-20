import { z } from 'zod';
import type { Db } from '../db/client.js';
import { auditLog, featureFlags, tradeGuardMisses } from '../db/schema.js';
import { deliverError } from './errors.js';

export const IncidentSchema = z.strictObject({ kind: z.enum(['guard_miss', 'rpc_outage', 'simulation_failure', 'stale_committer']) });
export type IncidentKind = z.infer<typeof IncidentSchema>['kind'];
export type IncidentAlert = { incidentId: number; kind: IncidentKind; severity: '1' | '2'; postMortemWithinHours?: number };
export type AlertSink = (alert: IncidentAlert) => Promise<void>;

export class IncidentService {
  /**
   * Wire durable incident storage and optional delivery sinks. Host-only construction; no admin
   * authentication or incident action occurs yet.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  constructor(private db: Db, private sinks: { page?: AlertSink; sentry?: AlertSink } = {}) {}
  /**
   * Disable trading_live and persist a severity-one guard-miss incident plus evidence outbox in
   * the supplied fill transaction. Host caller authenticates and supplies measured trade evidence;
   * SQL failure rolls back fill/evidence/stop together. Delivery occurs only after commit.
   */
  async recordTradeMiss(tx: Db, accountId: string, orderId: string, payload: Record<string, unknown>): Promise<IncidentAlert> {
    await tx.insert(featureFlags).values({ key: 'trading_live', enabled: false, audience: 'public' })
      .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: false, audience: 'public' } });
    const [record] = await tx.insert(auditLog).values({ accountId, action: 'ops.incident', data: {
      kind: 'guard_miss', severity: '1', delivery: 'prepared', orderId,
      scoreboardDraft: 'honeypots_missed', postMortemWithinHours: 24,
    } }).returning();
    await tx.insert(tradeGuardMisses).values({ orderId, incidentId: record!.id,
      payload: { ...payload, scoreboardKind: 'honeypots_missed', receiptPublication: 'pending',
        postMortemDueAt: new Date(Date.now() + 86_400_000).toISOString() } });
    return { incidentId: record!.id, kind: 'guard_miss', severity: '1', postMortemWithinHours: 24 };
  }
  /**
   * Persist supported incident and, for guard miss/RPC outage/simulation failure, trading_live=false
   * before delivering alerts. Caller must enforce allowlisted wallet admin/Origin; this service does
   * not authenticate. Missing/failed sinks are recorded without undoing the stop; transaction or
   * delivery-audit SQL failures reject. Stale committer does not stop trading.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
   */
  async raise(accountId: string, kind: IncidentKind) {
    const alert = await this.db.transaction(async tx => {
      if (kind === 'guard_miss' || kind === 'rpc_outage' || kind === 'simulation_failure') {
        await tx.insert(featureFlags).values({ key: 'trading_live', enabled: false, audience: 'public' })
          .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: false, audience: 'public' } });
      }
      const severity = kind === 'guard_miss' ? '1' : '2';
      const [record] = await tx.insert(auditLog).values({ accountId, action: 'ops.incident', data: {
        kind, severity, delivery: 'prepared', ...(kind === 'guard_miss' ? { scoreboardDraft: 'honeypots_missed', postMortemWithinHours: 24 } : {}),
      } }).returning();
      return { incidentId: record!.id, kind, severity, ...(kind === 'guard_miss' ? { postMortemWithinHours: 24 } : {}) } as IncidentAlert;
    });
    await this.deliver(accountId, alert);
    return { ...alert, prepared: true };
  }
  /**
   * Attempt page and Sentry sinks after the caller commits incident/stop state. Audit unavailable,
   * delivered or failed outcomes without undoing the stop; sink failures are absorbed, audit SQL
   * failures reject. Host callers enforce authorization and supply the finite alert.
   */
  async deliver(accountId: string, alert: IncidentAlert) {
    // The stop and audit commit before any sink. Missing or failed delivery never undoes the stop.
    for (const channel of ['page', 'sentry'] as const) {
      const sink = this.sinks[channel];
      let outcome = 'unavailable';
      if (sink) {
        try { await sink(alert); outcome = 'delivered'; }
        catch { outcome = 'failed'; }
      }
      await this.db.insert(auditLog).values({ accountId, action: 'ops.incident_delivery', data: { incidentId: alert.incidentId, channel, outcome } });
    }
  }
}
// Sentry gets only a finite incident code and severity; no caller payload, account, wallet or secret.
/**
 * Send only the finite incident kind and severity through the configured error-delivery sink.
 * Host-only invocation; no account/caller payload is forwarded. Unavailable delivery rejects so
 * raise can record failure.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export const sentryIncidentSink: AlertSink = async alert => {
  if (!await deliverError(new Error(`launch_incident_${alert.kind}`), { severity: alert.severity })) throw new Error('Incident Sentry delivery unavailable');
};
