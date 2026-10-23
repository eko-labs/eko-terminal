import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChainDb } from '@eko/db';
import { XIdSchema } from './parse.js';

export const XLimitsSchema = z.object({
  X_DAILY_REPLY_CAP: z.number().int().nonnegative().default(300),
  X_MONTHLY_BUDGET_USD: z.number().finite().min(0).max(400).default(400),
  // TODO(spec): §3.2 gives a 3M monthly read ceiling but no daily value; cap at 100k per UTC day.
  dailyReadCap: z.number().int().min(0).max(100000).default(100000),
  batchSize: z.number().int().min(5).max(100).default(10),
});
export type XLimits = z.input<typeof XLimitsSchema>;
interface State { cursor: string | null; token: string | null; newest: string | null; nextPollAt: number;
  owner: string | null; leaseUntil: number; stopped: boolean }
const initial: State = { cursor: null, token: null, newest: null, nextPollAt: 0, owner: null, leaseUntil: 0, stopped: false };
interface Usage { spend: number; reads: number; replies: number }
export interface PollLease { owner: string; cursor: string | null; token: string | null; day: string; month: string; reservedReads: number }
const periods = (now: number) => { const day = new Date(now).toISOString().slice(0, 10); return { day, month: day.slice(0, 7) }; };

export class XStore {
  readonly limits: z.output<typeof XLimitsSchema>;
  /**
   * Validate quota limits and identity HMAC key length, and wire durable store/clock. Host
   * construction performs no platform request or reservation.
   */
  constructor(readonly db: ChainDb, private readonly identityKey: string, limits: XLimits = {}, readonly now = Date.now) {
    if (identityKey.length < 32) throw new Error('X identity hashing key must have at least 32 characters');
    this.limits = XLimitsSchema.parse(limits);
  }
  private async locked<T>(fn: (db: ChainDb, state: State) => Promise<T>): Promise<T> {
    return this.db.tx(async db => {
      await db.sql.query('INSERT INTO x_bot_state(id,data) VALUES(1,$1::jsonb) ON CONFLICT DO NOTHING', [JSON.stringify(initial)]);
      const state = (await db.sql.query<{ data: State }>('SELECT data FROM x_bot_state WHERE id=1 FOR UPDATE')).rows[0].data;
      const result = await fn(db, state);
      await db.sql.query('UPDATE x_bot_state SET data=$1::jsonb WHERE id=1', [JSON.stringify(state)]);
      return result;
    });
  }
  private async usage(db: ChainDb, bucket: string): Promise<Usage> {
    return (await db.sql.query<Usage>('SELECT spend,reads,replies FROM x_bot_usage WHERE bucket=$1', [bucket])).rows[0]
      ?? { spend: 0, reads: 0, replies: 0 };
  }
  private async add(db: ChainDb, bucket: string, spend: number, reads: number, replies: number) {
    await db.sql.query(`INSERT INTO x_bot_usage(bucket,spend,reads,replies) VALUES($1,$2,$3,$4)
      ON CONFLICT(bucket) DO UPDATE SET spend=x_bot_usage.spend+excluded.spend,
      reads=x_bot_usage.reads+excluded.reads,replies=x_bot_usage.replies+excluded.replies`, [bucket, spend, reads, replies]);
  }
  private async reserve(db: ChainDb, spend: number, reads: number, replies: number) {
    const p = periods(this.now()), day = await this.usage(db, p.day), month = await this.usage(db, p.month);
    if (day.replies + replies > this.limits.X_DAILY_REPLY_CAP || day.reads + reads > this.limits.dailyReadCap ||
      month.reads + reads > 3000000 || month.spend + spend > Math.floor(this.limits.X_MONTHLY_BUDGET_USD * 1000000)) return false;
    await this.add(db, p.day, spend, reads, replies); await this.add(db, p.month, spend, reads, replies);
    return true;
  }
  /**
   * Under the state lock, enforce stop, poll interval, lease and daily/monthly read/spend caps
   * before reserving a page and a five-minute lease. Return null when unavailable; storage
   * failures reject.
   */
  async beginPoll(): Promise<PollLease | null> {
    return this.locked(async (db, state) => {
      const now = this.now();
      if (state.stopped || now < state.nextPollAt || (state.owner && now < state.leaseUntil)) return null;
      if (!await this.reserve(db, this.limits.batchSize * 5000, this.limits.batchSize, 0)) return null;
      state.owner = randomUUID(); state.leaseUntil = now + 300000; state.nextPollAt = now + 30000;
      return { owner: state.owner, cursor: state.cursor, token: state.token, ...periods(now), reservedReads: this.limits.batchSize };
    });
  }
  /**
   * Read whether the durable stop is clear and, when supplied, the owner still holds an unexpired
   * lease. No authentication or reservation occurs; SQL failures reject.
   */
  async allowed(owner?: string) {
    const state = (await this.db.sql.query<{ data: State }>('SELECT data FROM x_bot_state WHERE id=1')).rows[0]?.data;
    return !state?.stopped && (!owner || (state?.owner === owner && state.leaseUntil > this.now()));
  }
  /**
   * Persist the permanent bot stop under its state lock. Host lifecycle call; SQL failures reject
   * and this does not cancel already completed platform requests.
   */
  async stop() { await this.locked(async (_db, state) => { state.stopped = true; }); }
  /**
   * Refund unused reserved page reads/spend into the lease day/month buckets, charging at least
   * one read. Reject counts above reservation; caller settles the lease once and storage failures
   * propagate.
   */
  async settleReads(lease: PollLease, count: number) {
    // TODO(spec): empty polls and media billing are unspecified. Charge at least one read; reserve full reads on uncertain errors.
    const refund = lease.reservedReads - Math.max(1, count);
    if (refund < 0) throw new Error('X page exceeded reserved read count');
    await this.locked(async db => {
      await this.add(db, lease.day, -refund * 5000, -refund, 0);
      await this.add(db, lease.month, -refund * 5000, -refund, 0);
    });
  }
  /**
   * For the current unexpired lease, retain pagination state and advance the high-water cursor
   * only after the full window completes. Stale leases are ignored; caller supplies validated page
   * IDs and SQL failures reject.
   */
  async finishPage(lease: PollLease, ids: string[], token: string | null) {
    await this.locked(async (_db, state) => {
      if (state.owner !== lease.owner || state.leaseUntil <= this.now()) return;
      for (const id of ids) if (!state.newest || BigInt(id) > BigInt(state.newest)) state.newest = id;
      state.token = token;
      if (!token) {
        if (state.newest && (!state.cursor || BigInt(state.newest) > BigInt(state.cursor))) state.cursor = state.newest;
        state.newest = null;
      }
    });
  }
  /**
   * Clear the lease only if its owner still matches. Host cleanup; stale owners do not release
   * another poll and SQL failures reject.
   */
  async release(lease: PollLease) {
    await this.locked(async (_db, state) => { if (state.owner === lease.owner) { state.owner = null; state.leaseUntil = 0; } });
  }
  /**
   * Validate tweet/author IDs, hash the author and deduplicate the interaction under quota
   * locking. Enforce stop, three-per-hour author replies and daily/monthly spend caps; return
   * claimed, duplicate or limited. Caller verifies platform identity; SQL failures reject.
   */
  async claim(tweet: string, author: string): Promise<'claimed' | 'duplicate' | 'limited'> {
    XIdSchema.parse(tweet); XIdSchema.parse(author);
    const user = createHmac('sha256', this.identityKey).update(`x:user:${author}`).digest('hex');
    return this.locked(async (db, state) => {
      if (state.stopped) return 'limited';
      const claimed = (await db.sql.query(`INSERT INTO bot_interactions(platform,update_id,state)
        VALUES('x',$1,'claimed') ON CONFLICT DO NOTHING RETURNING update_id`, [tweet])).rows.length;
      if (!claimed) return 'duplicate';
      const count = (await db.sql.query<{ count: string }>('SELECT count(*) AS count FROM x_summons WHERE user_key=$1 AND reserved_at>$2', [user, this.now() - 3600000])).rows[0].count;
      if (Number(count) >= 3 || !await this.reserve(db, 10000, 0, 1)) {
        await db.sql.query("UPDATE bot_interactions SET state='limited' WHERE platform='x' AND update_id=$1", [tweet]);
        return 'limited';
      }
      await db.sql.query('INSERT INTO x_summons(tweet_id,user_key,reserved_at) VALUES($1,$2,$3)', [tweet, user, this.now()]);
      return 'claimed';
    });
  }
  /**
   * Persist a finite tweet-interaction completion state without retrying delivery. Caller supplies
   * a previously claimed tweet; SQL failures reject.
   */
  async finish(tweet: string, state: 'sent' | 'failed' | 'unavailable' | 'disabled') {
    await this.db.sql.query("UPDATE bot_interactions SET state=$2 WHERE platform='x' AND update_id=$1", [tweet, state]);
  }
  /**
   * Deduplicate a burn transaction and reserve posting spend under the state lock. Return false
   * for stopped, duplicate or budget-limited work; host supplies accepted burn identity and SQL
   * failures reject.
   */
  async claimBurn(tx: string) {
    return this.locked(async (db, state) => {
      if (state.stopped) return false;
      const rows = (await db.sql.query("INSERT INTO burn_posts(platform,burn_tx,state) VALUES('x',$1,'claimed') ON CONFLICT DO NOTHING RETURNING burn_tx", [tx])).rows;
      if (!rows.length) return false;
      if (await this.reserve(db, 15000, 0, 0)) return true;
      await db.sql.query("UPDATE burn_posts SET state='limited' WHERE platform='x' AND burn_tx=$1", [tx]); return false;
    });
  }
  /**
   * Persist a finite burn-post completion state. Host supplies the previously claimed transaction;
   * SQL failures reject and no send or burn occurs.
   */
  async finishBurn(tx: string, state: 'sent' | 'failed' | 'disabled') {
    await this.db.sql.query("UPDATE burn_posts SET state=$2 WHERE platform='x' AND burn_tx=$1", [tx, state]);
  }
}
