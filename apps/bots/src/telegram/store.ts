import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AddressSchema } from '@eko/shared';
import type { ChainDb } from '@eko/db';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const millis = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const CallerSchema = z.strictObject({
  id: z.string().uuid(), groupKey: hash, callerKey: hash, coin: AddressSchema,
  scanId: z.string().min(1).max(200), calledAt: millis,
});
export type Caller = z.infer<typeof CallerSchema>;
/** Task 112 supplies accepted, mature, cohort-relative grades; this bot owns no outcome oracle. */
// TODO(spec): cohort membership, grading thresholds and policy acceptance belong to 112; absent that accepted adapter, every grade stays pending.
export const AcceptedGradeSchema = z.strictObject({
  callId: z.string().uuid(), coin: AddressSchema, calledAt: millis,
  horizonSec: z.literal(86400), maturityAt: millis, knownAt: millis,
  accepted: z.literal(true), status: z.literal('confirmed_under_policy'),
  grade: z.enum(['above_cohort', 'at_cohort', 'below_cohort']),
  cohortId: z.string().min(1).max(200), cohortReceiptId: z.string().min(1).max(200),
  outcomeReceiptId: z.string().min(1).max(200), policyVersion: z.string().min(1).max(100),
  eligible: z.number().int().positive(), mature: z.number().int().positive(), censored: z.number().int().nonnegative(),
});
export type AcceptedGrade = z.infer<typeof AcceptedGradeSchema>;
export interface LeaderRow { caller: string; calls: number; pending: number; above: number; at: number; below: number }

export class TelegramStore {
  /**
   * Wire interaction storage, host clock and an identity HMAC key of at least 32 characters.
   * Invalid key length throws; no update, platform client or grade is created.
   */
  constructor(readonly db: ChainDb, private readonly identityKey: string, readonly now = Date.now) {
    if (identityKey.length < 32) throw new Error('Telegram identity hashing key must have at least 32 characters');
  }
  /**
   * Derive group-scoped caller HMAC keys from verified chat/user IDs without persisting raw IDs
   * here. Pure hashing; caller authenticates the webhook identity.
   */
  identities(chat: number, user: number) {
    const digest = (s: string) => createHmac('sha256', this.identityKey).update(s).digest('hex');
    const groupKey = digest(`telegram:group:${chat}`);
    return { groupKey, callerKey: digest(`telegram:caller:${groupKey}:${user}`) };
  }
  /**
   * Durably claim a Telegram update once using the platform/update uniqueness constraint. Return
   * false for duplicates; caller validates the update and secrets first, and SQL failures reject.
   */
  async claim(updateId: number): Promise<boolean> {
    const rows = (await this.db.sql.query(`INSERT INTO bot_interactions (platform,update_id,state)
      VALUES ('telegram',$1,'claimed') ON CONFLICT DO NOTHING RETURNING update_id`, [updateId])).rows;
    return rows.length === 1;
  }
  /**
   * Persist the supplied finite update completion state. Caller owns verified update handling; SQL
   * failures reject and this method performs no delivery.
   */
  async finish(updateId: number, state: 'sent' | 'ignored' | 'failed') {
    await this.db.sql.query("UPDATE bot_interactions SET state=$2 WHERE platform='telegram' AND update_id=$1", [updateId, state]);
  }
  /**
   * Validate and retain the first durably accepted caller record per group/coin, returning the
   * existing winner on conflict. Caller supplies HMAC identities and accepted scan data;
   * schema/storage failures reject.
   */
  async first(input: Omit<Caller, 'id'>): Promise<Caller> {
    const call = CallerSchema.parse({ ...input, id: randomUUID() });
    // TODO(spec): first means first durably accepted scan; Telegram arrival order can differ from message timestamps.
    const rows = (await this.db.sql.query<{ data: Caller }>(`INSERT INTO caller_calls(id,group_key,caller_key,coin,data)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(group_key,coin) DO NOTHING RETURNING data`,
    [call.id, call.groupKey, call.callerKey, call.coin, JSON.stringify(call)])).rows;
    if (rows[0]) return CallerSchema.parse(rows[0].data);
    return CallerSchema.parse((await this.db.sql.query<{ data: Caller }>(
      'SELECT data FROM caller_calls WHERE group_key=$1 AND coin=$2', [call.groupKey, call.coin])).rows[0].data);
  }
  /**
   * Accept a supplied cohort-relative 24-hour grade only when bound to the retained call, matured,
   * known by now and denominator-consistent. Append once; invalid/conflicting call input returns
   * false and storage failures reject. No outcome oracle is constructed.
   */
  async appendGrade(raw: unknown): Promise<boolean> {
    const parsed = AcceptedGradeSchema.safeParse(raw);
    if (!parsed.success) return false;
    const grade = parsed.data;
    const call = (await this.db.sql.query<{ data: Caller }>('SELECT data FROM caller_calls WHERE id=$1', [grade.callId])).rows[0]?.data;
    if (!call || call.coin !== grade.coin || call.calledAt !== grade.calledAt ||
      grade.maturityAt < call.calledAt + 86400000 || grade.knownAt < grade.maturityAt || grade.knownAt > this.now() ||
      grade.mature + grade.censored !== grade.eligible) return false;
    return (await this.db.sql.query(`INSERT INTO caller_grades(call_id,data) VALUES($1,$2::jsonb)
      ON CONFLICT DO NOTHING RETURNING call_id`, [call.id, JSON.stringify(grade)])).rows.length === 1;
  }
  /**
   * Read up to 100 mature ungraded group calls and pass injected upstream grades through
   * appendGrade. Host supplies the accepted grade reader; read/storage failures propagate and
   * missing evidence remains pending.
   */
  async gradePending(groupKey: string, readGrade: (call: Caller) => Promise<unknown>) {
    const calls = (await this.db.sql.query<{ data: Caller }>(`SELECT c.data FROM caller_calls c
      LEFT JOIN caller_grades g ON g.call_id=c.id WHERE c.group_key=$1 AND g.call_id IS NULL
      AND (c.data->>'calledAt')::bigint <= $2 ORDER BY c.id LIMIT 100`, [groupKey, this.now() - 86400000])).rows;
    for (const row of calls) await this.appendGrade(await readGrade(CallerSchema.parse(row.data)));
  }
  /**
   * Read a validated retained grade by call ID, returning null if absent. Caller supplies
   * authorized context; this storage helper does not scope access by group or authenticate.
   */
  async grade(callId: string): Promise<AcceptedGrade | null> {
    const row = (await this.db.sql.query<{ data: AcceptedGrade }>('SELECT data FROM caller_grades WHERE call_id=$1', [callId])).rows[0];
    return row ? AcceptedGradeSchema.parse(row.data) : null;
  }
  /**
   * Validate a HMAC group key and aggregate retained calls/grades into up to 100 pseudonymous
   * caller rows with pending counts. Return the badge only when calls exist; SQL failures reject
   * and no grade is fabricated.
   */
  async leaderboard(groupKey: string): Promise<{ badge: 'Scanned by EKO' | null; rows: LeaderRow[] }> {
    hash.parse(groupKey);
    const rows = (await this.db.sql.query<{ caller_key: string; calls: string; pending: string; above: string; at: string; below: string }>(`SELECT c.caller_key,
      count(*) AS calls, count(*) FILTER(WHERE g.call_id IS NULL) AS pending,
      count(*) FILTER(WHERE g.data->>'grade'='above_cohort') AS above,
      count(*) FILTER(WHERE g.data->>'grade'='at_cohort') AS at,
      count(*) FILTER(WHERE g.data->>'grade'='below_cohort') AS below
      FROM caller_calls c LEFT JOIN caller_grades g ON g.call_id=c.id WHERE c.group_key=$1
      GROUP BY c.caller_key ORDER BY above DESC, below ASC, c.caller_key LIMIT 100`, [groupKey])).rows;
    return { badge: rows.length ? 'Scanned by EKO' : null,
      rows: rows.map(r => ({ caller: `caller-${r.caller_key}`, calls: Number(r.calls), pending: Number(r.pending), above: Number(r.above), at: Number(r.at), below: Number(r.below) })) };
  }
}
